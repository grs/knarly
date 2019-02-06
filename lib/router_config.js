/*
 * Copyright 2019 Red Hat Inc.
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

var util = require('util');
var qdr = require('./qdr.js');
var myutils = require('./utils.js');
var log = require('./log.js').logger();

const MAX_RETRIES = 3;

function address_compare (a, b) {
    return myutils.string_compare(a.prefix, b.prefix);
}

function same_address_definition (a, b) {
    return a.prefix === b.prefix && a.distribution === b.distribution && a.waypoint === b.waypoint;
}

function address_describe (a) {
    return 'address ' + a.prefix;
}

function autolink_compare (a, b) {
    return myutils.string_compare(a.addr, b.addr) || myutils.string_compare(a.direction, b.direction) || myutils.string_compare(a.containerId, b.containerId);
}

function is_not_defined (a) {
    return a === null || a === '' || a === undefined;
}

function equivalent_container_id(a, b) {
    // empty string, null & undefined are all considered equivalent
    // for containerId
    return (is_not_defined(a) && is_not_defined(b)) || a === b;
}

function same_autolink_definition (a, b) {
    return a.addr === b.addr && a.direction === b.direction && equivalent_container_id(a.containerId, b.containerId);
}

function autolink_describe (a) {
    return 'autolink ' + a.name + ' (dir: ' + a.direction + ', addr: ' + a.addr + ')';
}

function linkroute_compare (a, b) {
    var result = myutils.string_compare(a.prefix, b.prefix);
    if (result === 0) {
        result = myutils.string_compare(a.direction, b.direction);
    }
    if (result === 0) {
        result = myutils.string_compare(a.containerId, b.containerId);
    }
    return result;
}

function same_linkroute_definition (a, b) {
    return a.prefix === b.prefix && a.direction === b.direction && equivalent_container_id(a.containerId, b.containerId);
}

function linkroute_describe (a) {
    return 'linkroute ' + a.direction + ' ' + a.prefix;
}

function listener_compare(a, b) {
    return myutils.string_compare(a.host, b.host) || myutils.string_compare(a.port, b.port);
}

function same_listener_definition(a, b) {
    return a.host === b.host && a.port === b.port && a.sslProfile === b.sslProfile && a.saslMechanisms === b.saslMechanisms && a.authenticatePeer === b.authenticatePeer;
}

function listener_describe (a) {
    return 'listener ' + a.name + ' (' + a.host + ':' + a.port + ')';
}

function exchange_compare (a, b) {
    return myutils.string_compare(a.address, b.address);
}

function same_exchange_definition (a, b) {
    //TODO: compare phase, alternateAddress, alternatePhase, matchMethod accounting for defaults
    return a.name === b.name && a.address === b.address;
}

function exchange_describe (a) {
    return 'exchange ' + a.name;
}

function binding_compare (a, b) {
    return myutils.string_compare(a.address, b.address);
}

function same_binding_definition (a, b) {
    //TODO: compare nextHopPhase, bindingKey accounting for defaults
    return a.exchangeName === b.exchangeName && a.nextHopAddress === b.nextHopAddress;
}

function binding_describe (a) {
    return 'binding ' + a.exchangeName + '->' + a.nextHopAddress;
}

const entities = [
    {
        name:'addresses',
        comparator:address_compare,
        equality:same_address_definition,
        describe:address_describe,
        type:'org.apache.qpid.dispatch.router.config.address',
        singular:'address'
    },
    {
        name:'autolinks',
        comparator:autolink_compare,
        equality:same_autolink_definition,
        describe:autolink_describe,
        type:'org.apache.qpid.dispatch.router.config.autoLink',
        singular:'autolink'
    },
    {
        name:'linkroutes',
        comparator:linkroute_compare,
        equality:same_linkroute_definition,
        describe:linkroute_describe,
        type:'org.apache.qpid.dispatch.router.config.linkRoute',
        singular:'linkroute'
    },
    {
        name:'listeners',
        comparator:listener_compare,
        equality:same_listener_definition,
        describe:listener_describe,
        type:'org.apache.qpid.dispatch.listener',
        singular:'listener'
    },
    {
        name:'exchanges',
        comparator:exchange_compare,
        equality:same_exchange_definition,
        describe:exchange_describe,
        type:'org.apache.qpid.dispatch.router.config.exchange',
        singular:'exchange'
    },
    {
        name:'bindings',
        comparator:binding_compare,
        equality:same_binding_definition,
        describe:binding_describe,
        type:'org.apache.qpid.dispatch.router.config.binding',
        singular:'binding'
    }
];

const directions = ['in', 'out'];

function get_router_id (router) {
    return router.connection ? router.connection.container_id : 'unknown-router';
}

function sort_config (config) {
    entities.forEach(function (entity) {
        config[entity.name].sort(entity.comparator);
    });
};

function delete_config_element(router, entity, element) {
    let router_id = get_router_id(router);
    log.debug('deleting %s on %s', entity.describe(element), router_id);
    return router.delete_entity(entity.type, element.name).then(function () {
        log.info('deleted %s on %s', entity.describe(element), router_id);
        return true;
    }).catch(function (error) {
        log.error('deleting %s on %s => %s', entity.describe(element), router_id, error.description);
        return false;
    });
}

function create_config_element(router, entity, element) {
    let router_id = get_router_id(router);
    log.debug('creating %s on %s', entity.describe(element), router_id);
    return router.create_entity(entity.type, element.name, element).then(function () {
        log.info('created %s on %s', entity.describe(element), router_id);
        return true;
    }).catch(function (error) {
        log.error('creating %s on %s => %s', entity.describe(element), router_id, error.description);
        return false;
    });
}

function retrieve_elements(entity, router) {
    let router_id = get_router_id(router);
    return router.query(entity.type).then(function (results) {
        if (Array.isArray(results)) {
            log.debug('retrieved %s from %s', entity.name, router_id);
            results.sort(entity.comparator);
            return results;
        } else {
            log.warn('unexpected result from retrieving %s from %s: %j', entity.name, router_id, results);
            return [];
        }
    }).catch(function (error) {
        log.error('error retrieving %s from %s: %s', entity.name, router_id, error);
        throw error;
    });

}

function print_list(prefix, list) {
    log.info('  %s', prefix);
    list.forEach(function (o) {
        log.info('    %j', o);
    });
}

function is_false(v) { return v === false; }

function debug_failures(entity, targets, results, actual) {
    for (let i = 0; i < results.length; i++) {
        if (!results[i]) {
            if (actual.some(entity.equality.bind(null, targets[i]))) {
                log.info('%s IS in retrieved list', entity.describe(targets[i]));
            } else {
                log.info('%s IS NOT in retrieved list', entity.describe(targets[i]));
            }
        }
    }
}

function report(entity, targets, results, actual, operation) {
    if (results.some(is_false)) {
        log.info('had %d %s, %s %d of which %d failed:', actual.length, entity.name, operation, targets.length, results.filter(is_false).length);
        debug_failures(entity, targets, results, actual);
    } else if (targets.length) {
        log.info('had %d %s, %s %d', actual.length, entity.name, operation, targets.length);
    }
}

function ensure_elements(entity, desired, router, collected, filter) {
    let router_id = get_router_id(router);
    return retrieve_elements(entity, router).then(function (actual) {
        var delta = myutils.changes(actual, desired, entity.comparator, entity.equality);
        if (delta) {
            log.debug('on %s, have %j, want %j => %s', router_id, actual, desired, delta.description);
            let stale = delta.removed.filter(filter).concat(delta.modified);
            let missing = delta.added.concat(delta.modified);

            if (stale.length || missing.length) {
                let delete_fn = delete_config_element.bind(null, router, entity);
                let create_fn = create_config_element.bind(null, router, entity);
                return Promise.all(stale.map(delete_fn)).then(
                    function (deletions) {
                        report(entity, stale, deletions, actual, 'deleted')
                        return Promise.all(missing.map(create_fn)).then(
                            function (creations) {
                                report(entity, missing, creations, actual, 'created')
                                return false;//recheck when changed
                            }
                        ).catch(function (error) {
                            log.error('Failed to create required %s: %s', entity.name, error);
                        });
                    }).catch(function (error) {
                        log.error('Failed to delete stale %s: %s', entity.name, error);
                    });
            } else {
                log.info('%s up to date on %s (ignoring %d elements)', entity.name, router_id, delta.removed.length);
                collected[entity.name] = actual;
                return true;
            }
        } else {
            log.info('%s up to date on %s', entity.name, router_id);
            collected[entity.name] = actual;
            return true;
        }
    }).catch(function (error) {
        log.error('error retrieving %s from %s: %s', entity.name, router_id, error);
        return false;
    });
}

function apply_config(desired, router, filter, count) {
    let iteration = count || 1;
    let router_id = get_router_id(router);
    log.info('checking configuration of %s', router_id);
    log.debug('applying %j to %s', desired, router_id);
    var actual = {};
    let promise = Promise.resolve(true);
    for (let i = 0; i < entities.length; i++) {
        let entity = entities[i];
        promise = promise.then(function (result_a) {
            return ensure_elements(entity, desired[entity.name], router, actual, filter).then(function (result_b) {
                return result_a && result_b;
            });
        });
    }
    return promise.then(function (ok) {
        if (ok) {
            log.info('configuration of %s is up to date', router_id);
            return actual;
        } else {
            log.error('configuration update for %s not up to date (attempt %d of %d)', router_id, iteration, MAX_RETRIES);
            if (iteration < MAX_RETRIES) {
                return apply_config(desired, router, filter, iteration + 1);
            } else {
                log.error('Unable to apply desired configuration; gave up after %d attempts', iteration);
                throw new Error(util.format('Unable to apply desired configuration; gave up after %d attempts', iteration));
            }
        }
    }).catch(function (error) {
        log.error('error while applying configuration to %s, retrying: %j', router_id, error);
        if (iteration < MAX_RETRIES) {
            return apply_config(desired, router, filter, iteration + 1);
        } else {
            log.error('Unable to apply desired configuration; gave up after %d attempts (%s)', iteration, error);
            throw new Error(util.format('Unable to apply desired configuration; gave up after %d attempts (%s)', iteration, error));
        }
    });
}

function RouterConfig(prefix) {
    this.prefix = prefix;
    this.autolinks = [];
    this.addresses = [];
    this.linkroutes = [];
    this.listeners = [];
    this.exchanges = [];
    this.bindings = [];
}

RouterConfig.prototype.add_address = function (a) {
    this.addresses.push(myutils.merge({name:this.prefix + a.prefix}, a));
    return this;
};

RouterConfig.prototype.add_autolink = function (a) {
    this.autolinks.push(myutils.merge({name: this.prefix + a.addr + '-' + a.containerId}, a));
    return this;
};

RouterConfig.prototype.add_listener = function (a) {
    this.listeners.push(myutils.merge({name:this.prefix + a.host + '-' + a.port}, a));
    return this;
};

RouterConfig.prototype.add_linkroute = function (l) {
    this.linkroutes.push(myutils.merge({name:this.prefix + l.prefix + '-' + l.containerId}, l));
    return this;
};

RouterConfig.prototype.add_exchange = function (e) {
    this.exchanges.push(myutils.merge({name:this.prefix + e.address}, e));
    return this;
};

RouterConfig.prototype.add_exchanges = function (e) {
    e.forEach(this.add_exchange.bind(this));
    return this;
};

RouterConfig.prototype.add_binding = function (b) {
    this.bindings.push(myutils.merge({name:this.prefix + b.exchangeName + b.nextHopAddress}, b));
    return this;
};

RouterConfig.prototype.add_bindings = function (e) {
    e.forEach(this.add_binding.bind(this));
    return this;
};

function distinct_container_per_direction(props) {
    if (props.containerId) {
        props.containerId = props.containerId + '-' + props.direction;
    }
    return props;
}

RouterConfig.prototype.add_autolink_pair = function (def) {
    for (let i = 0; i < directions.length; i++) {
        this.add_autolink(distinct_container_per_direction(myutils.merge({direction:directions[i]}, def)));
    }
    return this;
};

RouterConfig.prototype.add_autolink_in = function (def) {
    this.add_autolink(distinct_container_per_direction(myutils.merge({direction:'in'}, def)));
    return this;
}

RouterConfig.prototype.add_linkroute_pair = function (def) {
    for (let i = 0; i < directions.length; i++) {
        this.add_linkroute(distinct_container_per_direction(myutils.merge({direction:directions[i]}, def)));
    }
    return this;
};

function update_routers(router) {
    return router.get_all_routers().then(function (routers) {
        if (routers === undefined) {
            log.info('no routers found');
            return [];
        } else {
            return routers;
        }
    });
}

RouterConfig.prototype.apply_to_network = function (router) {
    var self = this;
    return update_routers(router).then(function (routers) {
        return routers.map(function (r) {
            return self.apply_to_router(r);
        });
    }).catch(console.error);
};

RouterConfig.prototype.apply_to_router = function (router) {
    var qualifier = this.prefix;
    function filter (record) {
        return record.name && record.name.indexOf(qualifier) === 0;
    }
    return apply_config(this, router, filter);
};

module.exports = {
    create: function (prefix) {
        return new RouterConfig(prefix);
    }
};
