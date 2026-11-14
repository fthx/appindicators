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

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import * as AppIndicator from './appIndicator.js';
import * as DBusMenu from './dbusMenu.js';
import * as PromiseUtils from './promiseUtils.js';
import * as Util from './util.js';

/*
 * IndicatorStatusIcon implements an icon in the system status area
 */
export const IndicatorStatusIcon = GObject.registerClass(
class IndicatorStatusIcon extends PanelMenu.Button {
    _init(indicator) {
        super._init(0.5, indicator.accessibleName);

        // Disable the upstream click gesture: buttons are handled by
        // vfunc_button_press_event(), to support middle and double clicks.
        this._clickGesture.set_enabled(false);

        this._indicator = indicator;
        this._menuClient = null;
        this._waitDoubleClickPromise = null;
        this._clickCount = 0;
        this._lastClickTime = -1;
        this._lastClickX = -1;
        this._lastClickY = -1;
        this._scrollX = 0;
        this._scrollY = 0;

        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box appindicator-box',
        });
        this._box.add_child(new AppIndicator.IconActor(indicator));
        this.add_child(this._box);

        indicator.connectObject(
            'ready', () => this._showIfReady(),
            'menu', () => this._updateMenu(),
            'label', () => this._updateLabel(),
            'status', () => this._updateStatus(),
            'reset', () => {
                this._updateStatus();
                this._updateLabel();
            },
            'accessible-name', () => this.set_accessible_name(indicator.accessibleName),
            'destroy', () => this.destroy(),
            this);

        // The menu client only lives while the icon is visible
        this.connect('notify::visible', () => this._updateMenu());

        this._showIfReady();
    }

    _onDestroy() {
        this._waitDoubleClickPromise?.cancel();
        this._destroyMenuClient();

        super._onDestroy();
    }

    _showIfReady() {
        if (!this._indicator.isReady)
            return;

        this._updateLabel();

        // A visibility change already updates the menu
        const wasVisible = this.visible;
        this._updateStatus();
        if (this.visible === wasVisible)
            this._updateMenu();
    }

    _updateLabel() {
        const {label} = this._indicator;

        if (label && !this._label) {
            this._label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            this._box.add_child(this._label);
        }

        if (this._label) {
            this._label.text = label ?? '';
            this._label.visible = !!label;
        }
    }

    _updateStatus() {
        const wasVisible = this.visible;
        this.visible = this._indicator.status !== AppIndicator.SNIStatus.PASSIVE;

        if (this.visible !== wasVisible)
            this._indicator.checkAlive().catch(logError);
    }

    _destroyMenuClient() {
        if (!this._menuClient)
            return;

        this._menuClient.destroy();
        this._menuClient = null;
        this.menu.removeAll();
    }

    _updateMenu() {
        this._destroyMenuClient();

        const {busName, menuPath} = this._indicator;
        if (!this.visible || !menuPath)
            return;

        const menuClient = new DBusMenu.Client(busName, menuPath, this._indicator);
        menuClient.connect('ready-changed', () => {
            if (menuClient.isReady)
                menuClient.attachToMenu(this.menu);
            else
                this._updateMenu();
        });
        this._menuClient = menuClient;
    }

    _updateClickCount(event) {
        const [x, y] = event.get_coords();
        const time = event.get_time();
        const {doubleClickDistance, doubleClickTime} = this.get_context().get_settings();

        if (time > this._lastClickTime + doubleClickTime ||
            Math.abs(x - this._lastClickX) > doubleClickDistance ||
            Math.abs(y - this._lastClickY) > doubleClickDistance)
            this._clickCount = 0;

        this._lastClickTime = time;
        this._lastClickX = x;
        this._lastClickY = y;
        this._clickCount = this._clickCount % 2 + 1;

        return this._clickCount;
    }

    // A simple click opens the menu, but only once it's not a double click
    async _waitForDoubleClick() {
        const {doubleClickTime} = this.get_context().get_settings();
        const promise = new PromiseUtils.TimeoutPromise(doubleClickTime);
        this._waitDoubleClickPromise = promise;

        try {
            await promise;
            this.menu.toggle();
        } catch (e) {
            if (!Util.isCancelled(e))
                throw e;
        } finally {
            if (this._waitDoubleClickPromise === promise)
                this._waitDoubleClickPromise = null;
        }
    }

    vfunc_event(event) {
        if (this.menu.numMenuItems && event.type() === Clutter.EventType.TOUCH_BEGIN)
            this.menu.toggle();

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(event) {
        this._waitDoubleClickPromise?.cancel();

        const button = event.get_button();
        const [x, y] = event.get_coords().map(Math.round);

        // middle click sends SecondaryActivate and does not show the menu
        if (button === Clutter.BUTTON_MIDDLE) {
            Main.panel.menuManager.activeMenu?.close();
            this._indicator.secondaryActivate(event.get_time(), x, y);
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_SECONDARY) {
            this.menu.toggle();
            return Clutter.EVENT_PROPAGATE;
        }

        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const supportsActivation = this._indicator.supportsActivation !== false;

        // double click activates the application
        if (supportsActivation && this._updateClickCount(event) === 2) {
            this._indicator.open(x, y, event.get_time());
            return Clutter.EVENT_STOP;
        }

        if (this.menu.numMenuItems) {
            if (supportsActivation)
                this._waitForDoubleClick().catch(logError);
            else
                this.menu.toggle();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        // Clutter always sends a smooth scrolling event with explicit deltas,
        // no matter what input device is used (emulated for the mouse wheels):
        // only these ones are interpreted.
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        // Accumulate the (possibly fractional) deltas into whole steps
        const [dx, dy] = event.get_scroll_delta();
        const stepX = this._accumulateScroll('_scrollX', dx);
        const stepY = this._accumulateScroll('_scrollY', dy);

        if (stepX || stepY)
            this._indicator.scroll(stepX, stepY);

        // The remainder of a touchpad gesture is dropped at its end
        const finishFlags = event.get_scroll_finish_flags();
        if (finishFlags & Clutter.ScrollFinishFlags.HORIZONTAL)
            this._scrollX = 0;
        if (finishFlags & Clutter.ScrollFinishFlags.VERTICAL)
            this._scrollY = 0;

        return Clutter.EVENT_STOP;
    }

    _accumulateScroll(accumulator, delta) {
        // A change of direction drops the remainder of the previous one
        if (Math.sign(this[accumulator]) === -Math.sign(delta))
            this[accumulator] = 0;

        this[accumulator] += delta;
        const step = Math.trunc(this[accumulator]);
        this[accumulator] -= step;

        return step;
    }
});
