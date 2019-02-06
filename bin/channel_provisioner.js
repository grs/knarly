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

var kubernetes = require('../lib/kubernetes').client();
var qdr = require('../lib/qdr');
var router_config = require('../lib/router_config');

const KNATIVE_CHANNEL = {
    group: 'eventing.knative.dev',
    version: 'v1alpha1',
    name: 'channels',
};

const KNATIVE_SUBSCRIPTION = {
    group: 'eventing.knative.dev',
    version: 'v1alpha1',
    name: 'subscriptions',
};

const QUALIFIER = 'knarly-';

var router = qdr.connect({ host: process.env.MESSAGING_SERVICE_HOST, container_id: 'provisioner' });

function to_exchange(channel) {
    return {address:channel.metadata.name};
}

function to_binding(subscription) {
    var sink = subscription.spec.subscriber.ref;
    //TODO: need to lookup sink ref in order to get the address? or is name good enough?
    return {exchangeName:QUALIFIER + subscription.spec.channel.name, nextHopAddress:sink.name};
}

function sync_bindings(expected) {
    return router_config.create(QUALIFIER).add_bindings(expected).apply_to_network(router);
}

function sync_exchanges(expected) {
    return router_config.create(QUALIFIER).add_exchanges(expected).apply_to_network(router);
}

var channels;
var subscriptions;

function known_channel(name) {
    return channels && channels.some(function (c) {
        return c.metadata.name === name;
    });
}

function valid_subscription(subscription) {
    if (known_channel(subscription.spec.channel.name)) {
        return true;
    } else {
        console.error('No channel %s for subscription %s', subscription.spec.channel.name, subscription.metadata.name);
        return false;
    }
}

function sync() {
    console.log('syncing...');
    if (channels) {
        var exchanges = channels.map(to_exchange);
        var config = router_config.create(QUALIFIER).add_exchanges(exchanges);
        if (subscriptions) {
            var bindings = subscriptions.filter(valid_subscription).map(to_binding);
            config.add_bindings(bindings);
        } else {
            console.log('No subscriptions yet defined');
        }
        console.log('applying config %j', config);
        return config.apply_to_network(router);
    } else {
        console.log('No channels yet defined');
    }
}

function channels_updated(latest) {
    channels = latest;
    console.log('channels: %j', channels);
    return sync();
}

function subscriptions_updated(latest) {
    subscriptions = latest;
    console.log('subscriptions: %j', subscriptions);
    return sync();
}

var channel_watcher = kubernetes.watch(KNATIVE_CHANNEL);
channel_watcher.on('updated', channels_updated);

var subscription_watcher = kubernetes.watch(KNATIVE_SUBSCRIPTION);
subscription_watcher.on('updated', subscriptions_updated);
