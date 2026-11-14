// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

import GLib from 'gi://GLib';

import * as PromiseUtils from './promiseUtils.js';

// The icon cache keeps the icon objects in case they're reused shortly afterwards.
// This is necessary for some indicators that rapidly switch between several icons:
// reusing the same icon object avoids looking it up and loading it again.
// Icons that are not used for a while are removed from the cache.

const GC_INTERVAL = 100; // seconds
const LIFETIME_TIMESPAN = 120; // seconds

export class IconCache {
    constructor() {
        this._cache = new Map(); // id -> {icon, expiration}
        this._gcTimeout = null;
    }

    add(id, icon) {
        this._cache.set(id, {icon, expiration: this._newExpiration()});
        this._scheduleGC();
        return icon;
    }

    get(id) {
        const entry = this._cache.get(id);
        if (!entry)
            return null;

        entry.expiration = this._newExpiration();
        return entry.icon;
    }

    clear() {
        this._cache.clear();
        this._gcTimeout?.cancel();
        this._gcTimeout = null;
    }

    destroy() {
        this.clear();
    }

    _newExpiration() {
        return GLib.get_monotonic_time() + LIFETIME_TIMESPAN * GLib.USEC_PER_SEC;
    }

    async _scheduleGC() {
        if (this._gcTimeout)
            return;

        const gcTimeout = new PromiseUtils.TimeoutSecondsPromise(GC_INTERVAL,
            GLib.PRIORITY_LOW);
        this._gcTimeout = gcTimeout;

        try {
            await gcTimeout;
        } catch {
            return; // cancelled
        } finally {
            if (this._gcTimeout === gcTimeout)
                this._gcTimeout = null;
        }

        const now = GLib.get_monotonic_time();
        this._cache.forEach(({expiration}, id) => {
            if (expiration < now)
                this._cache.delete(id);
        });

        if (this._cache.size)
            this._scheduleGC();
    }
}
