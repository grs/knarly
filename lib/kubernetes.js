/*
 * Copyright 2017 Red Hat Inc.
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
var http = require('http');
var https = require('https');
var fs = require('fs');
var util = require('util');
var events = require('events');
var querystring = require('querystring');
var set = require('./set.js');
var myutils = require('./utils.js');
var log = require("./log.js").logger();

const CLUSTER_SCOPE = {};

function watch_handler(collection) {
    var partial = undefined;
    return function (msg) {
        var content = partial ? partial + msg : msg;
        var start = 0;
        for (var end = content.indexOf('\n', start); end > 0; start = end + 1, end = start < content.length ? content.indexOf('\n', start) : -1) {
            var line = content.substring(start, end);
            var event;
            try {
                event = JSON.parse(line);
            } catch (e) {
                console.warn('Could not parse message as JSON (%s), assuming incomplete: %s', e, line);
                break;
            }
            collection[event.type.toLowerCase()](event.object);
        }
        partial = content.substring(start);
    }
}

var cache = {};

function read(file) {
    if (cache[file] === undefined) {
        cache[file] = fs.readFileSync(file);
        setTimeout(function () { cache[file] = undefined; }, 1000*60*5);//force refresh every 5 minutes
    }
    return cache[file];
}

function Client(options) {
    this.options = options || {};
}

Client.prototype.host = function () {
    return this.options.host || process.env.KUBERNETES_SERVICE_HOST;
};

Client.prototype.port = function () {
    return this.options.port || process.env.KUBERNETES_SERVICE_PORT;
};

Client.prototype.current_namespace = function () {
    return this.options.namespace || process.env.KUBERNETES_NAMESPACE || read('/var/run/secrets/kubernetes.io/serviceaccount/namespace');
};

Client.prototype.token = function () {
    return this.options.token || process.env.KUBERNETES_TOKEN || read('/var/run/secrets/kubernetes.io/serviceaccount/token');
};

Client.prototype.get = function (type, name, namespace) {
    return this._promisified_request('GET', this._resource_path(type, name, namespace), parsing_handler);
};

Client.prototype.list = function (type, scope, selector) {
    return this._promisified_request('GET', this._collection_path(type, scope, selector), parsing_handler);
};

Client.prototype.post = function(type, object, namespace) {
    return this._promisified_request('POST', this._collection_path(type, namespace), simple_handler, JSON.stringify(object));
};

Client.prototype.put = function(type, object, namespace) {
    return this._promisified_request('PUT', this._resource_path(type, object.metadata.name, namespace), simple_handler, JSON.stringify(object));
};

Client.prototype.delete_ = function(type, name, namespace) {
    return this._promisified_request('DELETE', this._resource_path(type, name, namespace), simple_handler);
};

Client.prototype._watch = function (type, scope, selector, handler) {
    return this._request('GET', this._collection_path(type, scope, selector, true), handler);
};

Client.prototype.watch = function (type, scope, selector) {
    var w = new Watcher(this, type, scope, selector);
    w.list();
    return w;
};

Client.prototype.update = function (type, name, transform, namespace) {
    var self = this;
    return this.get(type, name, namespace).then(function (original) {
        var updated = transform(original);
        if (updated !== undefined) {
            return self.put(type, updated, namespace).then(function (code) {
                return {code: code, object: updated};
            });
        } else {
            return {code: 304, object: original};
        }
    }).catch(function (code) {
        if (code === 404) {
            var created = transform(undefined);
            return self.post(type, created, namespace).then(function (code) {
                return {code: code, object: created};
            });
        } else {
            return {code: code};
        }
    });
};

function parsing_handler (resolve, reject) {
    var data = '';
    function handle_data (chunk) {
        data += chunk;
    }
    function handle_end (response) {
        if (response.statusCode === 200) {
            try {
                resolve(JSON.parse(data));
            } catch (e) {
                reject(response.statusCode, data);
            }
        } else {
            reject(response.statusCode, data);
        }
    }
    return {data:handle_data, end:handle_end, error:reject};
};

function simple_handler (resolve, reject) {
    var data = '';
    function handle_data (chunk) {
        data += chunk;
    }
    function handle_end (response) {
        resolve(response.statusCode, data);
    }
    return {data:handle_data, end:handle_end, error:reject};
};

Client.prototype._promisified_request = function (method, path, handler_factory, input) {
    var self = this;
    return new Promise(function (resolve, reject) {
        self._request(method, path, handler_factory(resolve, reject), input);
    });
};

Client.prototype._request = function (method, path, handler, input) {
    var opts = {
        host: this.host(),
        port: this.port(),
        method: method,
        path: path,
        rejectUnauthorized: false,//TODO: set CA then won't need this(?)
        headers: { 'Authorization': 'Bearer ' + this.token() }
    };
    var request = https.request(opts, function(response) {
        var data = '';
	response.on('data', function (chunk) { handler.data(chunk); });
	response.on('end', function () {
	    log.info('%s %s => %s %s', opts.method, opts.path, response.statusCode, http.STATUS_CODES[response.statusCode]);
            handler.end(response);
        });
    });
    request.on('error', function (e) {
        if (handler.error) handler.error(e);
        console.error(e);
    })
    if (input) request.write(input);
    request.end();
};

Client.prototype._resource_path = function (type, name, namespace) {
    if (typeof type === 'string') {
        return '/api/v1/namespaces/' + this.current_namespace() + '/' + type + '/' + name;
    } else {
        return '/apis/' + type.group + '/' + type.version + '/namespaces/' + this.current_namespace() + '/' + type.name + '/' + name;
    }
}

Client.prototype._collection_path = function (type, scope, selector, watch) {
    var path = [];
    var typename;
    if (typeof type === 'string') {
        path.push('/api/v1');
        typename = type;
    } else {
        path = path.concat(['/apis', type.group, type.version]);
        typename = type.name;
    }

    if (scope === undefined) {
        //assume current namespace
        path = path.concat('namespaces', this.current_namespace());
    } else if (scope !== CLUSTER_SCOPE) {
        //treat scope as namespace
        path = path.concat('namespaces', scope);
    } //else cluster scope

    path.push(typename);
    path = path.join('/');

    if (selector || watch) {
        var params = {};
        if (selector) {
            params.labelSelector = selector;
        }
        if (watch) {
            params.watch = 1;
        }
        path += '?' + querystring.stringify(params);
    }
    return path;
}

function name_compare(a, b) {
    return myutils.string_compare(a.metadata.name, b.metadata.name);
};

function Watcher (client, type, scope, selector) {
    events.EventEmitter.call(this);
    this.client = client;
    this.type = type;
    this.scope = scope;
    this.selector = selector;
    this.closed = false;
    this.set = set.sorted_object_set(name_compare);
    this.delay = 0;
    this.notify = myutils.coalesce(this._notify.bind(this), 100, 5000);
}

util.inherits(Watcher, events.EventEmitter);

Watcher.prototype._notify = function () {
    var self = this;
    setImmediate( function () {
        self.emit('updated', self.set.to_array());
    });
};

Watcher.prototype.list = function () {
    var self = this;
    this.client.list(this.type, this.scope, this.selector).then(function (result) {
        self.delay = 0;
        self.set.reset(result.items);
        self.notify();
        if (!self.closed) {
            log.debug('list retrieved; watching...');
            self.watch();
        } else {
            self.emit('closed');
        }
    }).catch(function (error) {
        console.error('failed to retrieve %s: %s (retry in %d seconds)', self.resource, error, self.delay);
        setTimeout(self.list.bind(self), self.delay * 1000);
        self.delay = Math.min(30, self.delay + 1);
    });
};

Watcher.prototype.watch = function () {
    var self = this;
    var handler = {
        data: watch_handler,
        end: function() {
            if (!self.closed) {
                log.debug('response ended; reconnecting...');
                self.list();
            } else {
                self.emit('closed');
            }
        }
    };

    this.client._watch(this.type, this.scope, this.selector, handler);
};

function matcher(object) {
    return function (o) { return o.metadata.name === object.metadata.name; };
};

Watcher.prototype.added = function (object) {
    if (this.set.insert(object)) {
        this.notify();
        return true;
    } else {
        return false;
    }
};

Watcher.prototype.modified = function (object) {
    if (this.set.replace(object)) {
        this.notify();
        return true;
    } else {
        return false;
    }
};

Watcher.prototype.deleted = function (object) {
    if (this.set.remove(object)) {
        this.notify();
        return true;
    } else {
        return false;
    }
};

Watcher.prototype.close = function () {
    this.closed = true;
    var self = this;
    return new Promise(function (resolve) {
        self.once('closed', function () {
            resolve();
        });
    });
};

module.exports.CLUSTER_SCOPE = CLUSTER_SCOPE;

module.exports.client = function (options) {
    return new Client(options);
};
