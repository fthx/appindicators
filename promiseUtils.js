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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function cancelledError() {
    return new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED,
        'Promise cancelled');
}

/**
 * A promise that can be cancelled, directly or through a Gio.Cancellable.
 * The promises it is chained to (then(), catch()...) are plain promises.
 */
export class CancellablePromise extends Promise {
    static get [Symbol.species]() {
        return Promise;
    }

    constructor(executor, cancellable = null) {
        let resolve, reject;
        super((res, rej) => {
            resolve = res;
            reject = rej;
        });

        this._pending = true;
        this._resolve = value => this._settle(resolve, value);
        this._reject = error => this._settle(reject, error);

        if (cancellable?.is_cancelled()) {
            this._reject(cancelledError());
            return;
        }

        if (cancellable) {
            this._cancellable = cancellable;
            this._cancellableId = cancellable.connect(() => {
                // g_cancellable_disconnect() can't be called from the handler
                const id = this._cancellableId;
                this._cancellableId = 0;
                GLib.idle_add_once(GLib.PRIORITY_DEFAULT, () => cancellable.disconnect(id));
                this.cancel();
            });
        }

        executor(this._resolve, this._reject);
    }

    _settle(settle, value) {
        if (!this._pending)
            return;

        this._pending = false;
        this._cleanup();
        settle(value);
    }

    // May be called before the subclass constructor is done
    _cleanup() {
        if (this._cancellableId) {
            this._cancellable.disconnect(this._cancellableId);
            this._cancellableId = 0;
        }
    }

    pending() {
        return this._pending;
    }

    cancel() {
        this._reject(cancelledError());
        return this;
    }
}

export class SignalConnectionPromise extends CancellablePromise {
    constructor(object, signal, cancellable = null) {
        let signalId = 0;
        super(resolve => {
            signalId = object.connect(signal, (_object, ...args) =>
                resolve(args.length > 1 ? args : args[0]));
        }, cancellable);

        this._object = object;
        this._signalId = signalId;
    }

    _cleanup() {
        if (this._signalId) {
            this._object.disconnect(this._signalId);
            this._signalId = 0;
        }

        super._cleanup();
    }
}

class GSourcePromise extends CancellablePromise {
    constructor(source, priority, cancellable) {
        super(resolve => {
            source.set_priority(priority);
            source.set_callback(() => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            source.attach(null);
        }, cancellable);

        // The source is not attached if the promise was cancelled already
        if (this.pending())
            this._source = source;
    }

    _cleanup() {
        this._source?.destroy();
        this._source = null;

        super._cleanup();
    }
}

export class IdlePromise extends GSourcePromise {
    constructor(priority = GLib.PRIORITY_DEFAULT_IDLE, cancellable = null) {
        super(GLib.idle_source_new(), priority, cancellable);
    }
}

export class TimeoutPromise extends GSourcePromise {
    constructor(interval, priority = GLib.PRIORITY_DEFAULT, cancellable = null) {
        super(GLib.timeout_source_new(interval), priority, cancellable);
    }
}

export class TimeoutSecondsPromise extends GSourcePromise {
    constructor(interval, priority = GLib.PRIORITY_DEFAULT, cancellable = null) {
        super(GLib.timeout_source_new_seconds(interval), priority, cancellable);
    }
}
