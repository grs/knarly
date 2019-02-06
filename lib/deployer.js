/*
 * Copyright 2018 Red Hat Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var kubernetes = require('./kubernetes').client();
var monitor = require('./monitor').create();
var trigger = require('./trigger').create();

function qdr_proxy(address) {
    return {
        name: 'qdr-proxy',
        image: 'gordons/qdr-proxy:latest',
        imagePullPolicy: 'IfNotPresent',
        ports: [
            {
                containerPort: 15001
            }
        ],
        command: ['node', '/opt/app-root/src/bin/proxy.js'].concat([address + '=localhost:8080', address + '_ctrl=localhost:8080'])
    };
}

function jaeger_sidecar () {
    return {
        name: 'jaeger-agent',
        image: 'jaegertracing/jaeger-agent',
        imagePullPolicy: 'IfNotPresent',
        ports: [
            {
                containerPort: 5775,
                protocol: 'UDP'
            },
            {
                containerPort: 5778
            },
            {
                containerPort: 6831,
                protocol: 'UDP'
            },
            {
                containerPort: 6832,
                protocol: 'UDP'
            }
        ],
        command: [
            '/go/bin/agent-linux',
            '--collector.host-port=jaeger-collector:14267'
        ]
    };
}

function deployment(name, version, replicas) {
    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: name
        },
        spec: {
            selector: {
                matchLabels: {
                    name: name
                }
            },
            replicas: replicas || 0,
            template: {
                metadata: {
                    labels: {
                        name: name,
                        version: version || 'v1'
                    }
                },
                spec: {
                    containers: []
                }
            }
        }
    };
}

function get_container_spec(service_spec) {
    //TODO: make more robust and handle types other than runLatest
    return service_spec.runLatest.configuration.revisionTemplate.spec.container;
}

function equal_array(a, b) {
    if (a === undefined || b === undefined) return a === undefined && b === undefined;
    if(a.length !== b.length) {
        return false;
    }
    for(var i = 0; i < a.length; i++) {
        if(a[i] !== b[i]) return false;
    }
    return true;
}

function env_sort(a, b) {
    if (a.name === b.name) return 0;
    else if (a.name < b.name) return -1;
    else return 1;
}

function equal_env(a, b) {
    if (a === undefined || b === undefined) return a === undefined && b === undefined;
    if (a.length === b.length) {
        a.sort(env_sort);
        b.sort(env_sort);
        for (var i = 0; i < a.length; i++) {
            if (a[i].name !== b[i].name || a[i].value !== b[i].value) {
                return false;
            }
        }
        return true;
    } else {
        return false;
    }
}

function get_deployment_fn(name, image, env) {
    return function (original) {
        var updated = undefined;
        if (original) {
            // check that all three expected containers are present and correct
            for (var i = 0; i < original.spec.template.spec.containers.length && !updated; i++) {
                var container = original.spec.template.spec.containers[i];
                if (container.name === name) {
                    if (container.image !== image || !equal_env(container.env, env)) {
                        updated = original;
                    }
                } else if (container.name === 'qdr-proxy') {
                    var c = qdr_proxy(name);
                    if (container.image !== c.image || !equal_env(container.env, c.env) || !equal_array(container.command, c.command)) {
                        updated = original;
                    }
                } else if (container.name === 'jaeger-agent') {
                    var c = jaeger_sidecar();
                    if (container.image !== c.image || !equal_env(container.env, c.env) || !equal_array(container.command, c.command)) {
                        updated = original;
                    }
                } else {
                    // TODO: what if there are extra containers? (ignored for now)
                }
            }
        } else {
            updated = deployment(name);
        }
        if (updated) {
            updated.spec.template.spec.containers = [
                {name:name, image:image, env:env, imagePullPolicy: 'IfNotPresent'},
                qdr_proxy(name),
                jaeger_sidecar()
            ];
            return updated;
        } else {
            return undefined;
        }
    };
}

const KNATIVE_SERVICE = {
    group: 'serving.knative.dev',
    version: 'v1alpha1',
    name: 'services',
};

const DEPLOYMENT = {
    group: 'apps',
    version: 'v1',
    name: 'deployments',
};

function scaleup(deployment) {
    //TODO: handle configured maximum replicas
    deployment.spec.replicas++;
    return deployment;
}

function scaledown(deployment) {
    if (deployment.spec.replicas > 1) {
        deployment.spec.replicas--;
        return deployment;
    } else {
        return undefined;
    }
}

function idle(deployment) {
    if (deployment.spec.replicas) {
        deployment.spec.replicas = 0;
        return deployment;
    } else {
        return undefined;
    }
}

function Scaling(name, namespace) {
    this.name = name;
    this.namespace = namespace;
    this.suppress_idle = false;
}

Scaling.prototype.update = function (action) {
    var self = this;
    kubernetes.update(DEPLOYMENT, this.name, action).then(function (code) {
        console.log('%s %s/%s', action.name, self.namespace, self.name);
    }).catch(function (code) {
        console.log('failed to %s %s/%s: %s', action.name, self.namespace, self.name, code);
    });
};

Scaling.prototype.scaleup = function () {
    this.update(scaleup);
};

Scaling.prototype.scaledown = function () {
    this.update(scaledown);
};

Scaling.prototype.idle = function () {
    if (!this.suppress_idle) {
        this.suppress_idle = true;
        trigger.set_trigger(this.name, this);
        this.update(idle);
    }
};
Scaling.prototype.trigger_complete = function () {
    var self = this;
    setTimeout(function () {
        self.suppress_idle = false;
    }, 60000);
};

function Deployer() {
    // watch for kservice instances
    this.watcher = kubernetes.watch(KNATIVE_SERVICE);
    this.watcher.on('updated', this.updated.bind(this));
    this.monitoring = {};
}

Deployer.prototype.updated = function (services) {
    console.log('got update: %j', services);
    // for each service, check that a corresponding deployment exists
    // and is correctly setup, else create or edit it
    var self = this;
    services.forEach(function (service) {
        var container = get_container_spec(service.spec);
        var scaling;
        if (self.monitoring[service.metadata.name] === undefined) {
            scaling = new Scaling(service.metadata.name, service.metadata.namespace);
            self.monitoring[service.metadata.name] = monitor.monitor(service.metadata.name, scaling);
        }
        self.deploy(service.metadata.name, service.metadata.namespace, container.image, container.env).then(function (dep) {
            if (dep) {
                if (dep.spec.replicas === 0) {
                    if (scaling) {
                        console.log('activation trigger set for %s', scaling.name);
                        trigger.set_trigger(scaling.name, scaling);
                    } else {
                        console.log('No scaling controller; cannot set trigger');
                    }
                }
            } else {
                console.log('No deployment returned from deploy()');
            }
        });
    });
    for (var name in this.monitoring) {
        //TODO: cancel stale monitors
    }
};

Deployer.prototype.deploy = function (name, namespace, image, env) {
    // construct deployment
    return kubernetes.update(DEPLOYMENT, name, get_deployment_fn(name, image, env)).then(function (result) {
        var code = result.code;
        if (code >= 200 && code < 300) {
            console.log('deployed %s to %s/%s', image, namespace, name);
            return result.object;
        } else if (code >= 300 && code < 400) {
            console.log('did not need to deploy %s to %s/%s', image, namespace, name);
            return result.object;
        } else if (code >= 400) {
            console.log('error deploying %s to %s/%s: %s', image, namespace, name, code);
        }
    }).catch(function (code) {
        console.error('failed to deploy %s to %s/%s: %s', image, namespace, name, code);
    });
};

Deployer.prototype.close = function () {
    this.watcher.close();
};

module.exports.create = function () {
    return new Deployer();
};
