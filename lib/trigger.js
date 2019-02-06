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

var rhea = require('rhea');

function bind(sub, event) {
    sub.session.on(event, sub['on_' + event].bind(sub));
}

function Subscription(connection, address, controller) {
    this.address = address;
    this.controller = controller;
    this.session = connection.create_session();
    this.session.open();
    this.delivery = undefined;
    this.active = true;
    bind(this, 'message');
    bind(this, 'sendable');
    bind(this, 'sender_close');
    bind(this, 'session_open');
}

Subscription.prototype.on_session_open = function (context) {
    console.log('opened session to monitor messages for %s', this.address);
    this.receiver = this.session.open_receiver({source:this.address, autoaccept:false, credit_window:0});
    this.receiver.add_credit(1);
};

Subscription.prototype.on_message = function (context) {
    console.log('trigger activated for %s', this.address);
    this.active = false;
    this.controller.scaleup();
    this.delivery = context.delivery;
    context.session.open_sender(this.address + '_ctrl');
};

Subscription.prototype.on_sendable = function (context) {
    console.log('consumer ready on %s_ctrl', this.address);
    this.controller.trigger_complete();
    this.delivery.release();
    context.sender.close();
};

Subscription.prototype.on_sender_close = function (context) {
    console.log('closing session monitor messages for %s', this.address);
    this.session.close();
    this.cleanup();
};

function Trigger() {
    //TODO: more configurable connection options (e.g. connect.json?)
    this.connection = rhea.connect({ host: process.env.MESSAGING_SERVICE_HOST, container_id: 'trigger' });
    this.subscriptions = {};
}

Trigger.prototype.set_trigger = function (address, controller) {
    var sub = this.subscriptions[address];
    if (sub === undefined || sub.active === false) {
        sub = new Subscription(this.connection, address, controller);
        this.subscriptions[address] = sub;
        var self = this;
        sub.cleanup = function () {
            delete self.subscriptions[address];
        };
    }
};

module.exports.create = function () {
    return new Trigger();
};
