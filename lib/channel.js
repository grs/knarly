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

var http = require('http');//TODO: support for https
var url_parse = require('url').parse;
var amqp = require('rhea');

function Subscription(connection, address) {
    this.address = address;
    this.sender = connection.open_sender(address);
    this.deliveries = {};
    this.sender.on('accepted', this.ok.bind(this));
    ['released', 'modified', 'rejected'].forEach(function (s) {
        this.sender.on(s, this.fail.bind(this));
    });
    this.sender.on('settled', this.settled.bind(this));
}

Subscription.prototype.send = function (message) {
    var self = this;
    return new Promise(function (resolve, reject) {
        var delivery = self.sender.send(message);
        self.deliveries[delivery] = {resolve:resolve, reject:reject};
    });
};

Subscription.prototype.ok = function (context) {
    var p = this.deliveries[context.delivery];
    if (p) {
        p.resolve();
    } else {
        console.error('no record was found for accepted delivery');
    }
};

Subscription.prototype.fail = function (context) {
    //TODO: retry
    var p = this.deliveries[context.delivery];
    if (p) {
        p.reject();
    } else {
        console.error('no record was found for failed delivery');
    }
};

Subscription.prototype.settled = function (context) {
    delete this.deliveries[context.delivery];
};

function Channel() {
    this.subscriptions = [];
    this.server = http.createServer(outbound);
    this.port = process.env.PORT || 8080;
    server.listen(port, '0.0.0.0');
    this.container = amqp.create_container({id:process.env.CONTAINER_ID || process.env.HOSTNAME});
    this.connection = this.container.connect();
}

Channel.prototype.incoming = function (request, response) {
    var self = this;
    var body = '';
    request.on('data', function (data) { body += data; });
    request.on('end', function () {
        var message_out = {
            subject: request.method,
            application_properties: {},
            message_annotations: {},
            body: body
        };
        for (var key in request.headers) {
            if (key === 'content-type') {
                message_out.content_type = request.headers[key];
            } else {
                message_out.application_properties[key] = request.headers[key];
            }
        }
        message_out.application_properties['path'] = path;

        Promise.all(self.subscriptions.map(function (sub) {
            return sub.send(message);
        })).then(function () {
            response.statusCode = 200;
            response.end();
        }).catch(function () {
            response.statusCode = 500;//other code?
            response.end('Could not deliver event');
        });
    });

};

module.exports.create = function () {
    return new Channel();
};

