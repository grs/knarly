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
var Router = require('./qdr.js').Router;
var log = require("./log.js").logger();

function Deltas(name, max) {
    this.name = name;
    this.last = undefined;
    this.current = 0;
    this.deltas = [];
    this.max = max;
}

Deltas.prototype.add = function (value) {
    this.current += value;
};

Deltas.prototype.update = function () {
    if (this.deltas.length >= this.max) {
        this.deltas.shift();
    }
    this.deltas.push(this.current - this.last);
    this.last = this.current;
    this.current = 0;
    console.log('updated %s: %j', this.name, this.deltas);
};

function sign(delta) {
    if (delta < 0) return -1;
    else if (delta > 0) return 1;
    else return 0;
}

function trend(a, b) {
    if (b === 0 || sign(a) === sign(b)) return sign(a);
    else return 0;
}

function add(a, b) {
    return a + b;
}

Deltas.prototype.trend = function () {
    if (this.deltas.length === this.max) {
        return trend(this.deltas.slice(-3).reduce(trend), this.deltas.reduce(add));
    } else {
        // monitor for a bit longer before trying to determine trend
        return undefined;
    }
};

Deltas.prototype.no_change = function () {
    if (this.deltas.length === this.max) {
        return this.deltas.every(function (v) { return v === 0; });
    } else {
        return undefined;
    }
};

const INCREASE = 1;
const DECREASE = -1;
const STABLE = 0;
const IDLE = -100;

function AddressStats(address, controller) {
    this.address = address;
    this.controller = controller;
    this.delivered = new Deltas('deliveryCount', 10);
    this.undelivered = new Deltas('undeliveredCount', 10);
    this.unsettled = new Deltas('unsettledCount', 10);
    this.stats = [this.undelivered, this.unsettled, this.delivered];
    this.pause_cycles = 0;//number of intervals to wait before taking further actions
}

AddressStats.prototype.add = function (linkstats) {
    this.stats.forEach(function (d) { d.add(linkstats[d.name]); });
};

AddressStats.prototype.update = function () {
    this.stats.forEach(function (d) { d.update(); });
    if (this.pause_cycles) {
        this.pause_cycles--;
    } else {
        switch (this.action()) {
        case INCREASE:
            this.pause_cycles = 5;
            this.controller.scaleup();
            break;
        case DECREASE:
            this.pause_cycles = 5;
            this.controller.scaledown();
            break;
        case IDLE:
            this.pause_cycles = 10;
            this.controller.idle();
            break;
        }
    }

};

AddressStats.prototype.action = function () {
    var undelivered_trend = this.undelivered.trend();
    var unsettled_trend = this.unsettled.trend();
    if (undelivered_trend > 0) {
        //if undelivered count is going up, need more consumers
        return INCREASE;
    } else if  (undelivered_trend === 0 && unsettled_trend > 0) {
        //if undelivered is not decreasing and unsettled is increasing, need more consumers
        return INCREASE;
    } else if (this.undelivered.last === 0 && this.undelivered.no_change() && unsettled_trend < 0) {
        //if there are no undelivered messages and unsettled count is falling, may be able
        //to reduce consumers
        //TODO: improve this to avoid oscillating consumers up and down
        return DECREASE;
    } else if (this.delivered.no_change() && this.unsettled.last === 0 && this.unsettled.no_change()) {
        console.log('idle %s', this.name);
        return IDLE;
    } else {
        console.log('stable %', this.name);
        return STABLE;
    }
};

function Monitor() {
    //TODO: more configurable connection options (e.g. connect.json?)
    this.router = new Router(rhea.connect({ host: process.env.MESSAGING_SERVICE_HOST, container_id: 'activator' }));
    this.addresses = {};
    var self = this;
    this.router.get_all_routers().then(function (routers) {
        self.routers = routers;
        log.info('routers: ' + self.routers.map(function (r) { return r.target; }));
    });
    setInterval(this.update.bind(this), 200);
}

Monitor.prototype.monitor = function (address, controller) {
    if (this.addresses[address] === undefined) {
        this.addresses[address] = new AddressStats(address, controller);
    } else {
        console.log('Already monitoring: %s', address);
    }
};

function same_list(a, b, comparator) {
    var equal = comparator || function (x, y) { return x === y; };
    if (a === undefined || b === undefined || a.length !== b.length) {
        return false;
    } else {
        for (var i = 0; i < a.length; i++) {
            if (!equal(a[i], b[i])) return false;
        }
        return true;
    }
}

function same_routers(a, b) {
    return same_list(a, b, function (x, y) { return x.target === y.target; });
}

Monitor.prototype.update_routers = function () {
    var self = this;
    return this.router.get_all_routers(this.routers).then(function (routers) {
        if (routers === undefined) {
            log.info('no routers found');
            return [];
        } else {
            if (!same_routers(routers, self.routers)) {
                log.info('routers changed: ' + routers.map(function (r) { return r.target; }));
            }
            self.routers = routers;
            return self.routers;
        }
    });
};

function clean_address (address) {
    if (!address) {
        return address;
    } else if (address.charAt(0) === 'M') {
        return address.substring(2);
    } else {
        return address.substring(1);
    }
}

function is_consumer_link (link) {
    return link.linkType === 'endpoint' && link.linkDir === 'out';
}

Monitor.prototype.update = function () {
    var self = this;
    return this.update_routers().then(function (routers) {
        return Promise.all(routers.map(function (router) { return router.get_links(); })).then(function (results) {
            results.forEach(function (links) {
                links.filter(is_consumer_link).forEach(function (link) {
                    var stats = self.addresses[clean_address(link.owningAddr)];
                    if (stats) {
                        stats.add(link);
                    }
                });
            });
            for (var a in self.addresses) {
                var stats = self.addresses[a];
                stats.update();
            }
        });
    });
};

module.exports.create = function () {
    return new Monitor();
};
