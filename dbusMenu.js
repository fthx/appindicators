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
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as Interfaces from './interfaces.js';
import * as PromiseUtils from './promiseUtils.js';
import * as Util from './util.js';
import {DBusProxy} from './dbusProxy.js';

Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_async');

// ////////////////////////////////////////////////////////////////////////
// PART ONE: "ViewModel" backend implementation.
// Both code and design are inspired by libdbusmenu
// ////////////////////////////////////////////////////////////////////////

// The properties we use, so we won't have to deal with type mismatches
const PROPERTY_TYPES = {
    'visible': 'b',
    'enabled': 'b',
    'label': 's',
    'type': 's',
    'children-display': 's',
    'icon-name': 's',
    'icon-data': 'ay',
    'toggle-type': 's',
    'toggle-state': 'i',
};

const DEFAULT_PROPERTIES = {
    'visible': true,
    'enabled': true,
    'label': '',
    'type': 'standard',
};

// The properties that require a new shell menu item when they change
const LAYOUT_PROPERTIES = ['type', 'children-display'];

/**
 * Represents a single menu item
 */
class DbusMenuItem extends Signals.EventEmitter {
    constructor(client, id, properties, childrenIds) {
        super();

        this._client = client;
        this._id = id;
        this._properties = new Map();
        this._childrenIds = childrenIds;

        Object.entries(properties).forEach(([name, value]) =>
            this._setProperty(name, value));
    }

    // Returns whether the property changed
    _setProperty(name, value) {
        if (value && name in PROPERTY_TYPES && value.get_type_string() !== PROPERTY_TYPES[name]) {
            console.warn(`Cannot set menu item property ${name}: type mismatch!`);
            return false;
        }

        const oldValue = this._properties.get(name);
        if (value ? oldValue?.equal(value) : !oldValue)
            return false;

        if (value)
            this._properties.set(name, value);
        else
            this._properties.delete(name);

        return true;
    }

    // Returns the unpacked value of the property, or its default value
    propertyGet(name) {
        return this._properties.get(name)?.deepUnpack() ?? DEFAULT_PROPERTIES[name] ?? null;
    }

    propertyGetVariant(name) {
        return this._properties.get(name) ?? null;
    }

    propertySet(name, value) {
        if (this._setProperty(name, value))
            this.emit('property-changed', name);
    }

    // The properties that are not in the new set get their default value
    replaceProperties(properties) {
        [...this._properties.keys()].forEach(name => {
            if (!(name in properties))
                this.propertySet(name, null);
        });

        Object.entries(properties).forEach(([name, value]) =>
            this.propertySet(name, value));
    }

    getChildrenIds() {
        return [...this._childrenIds];
    }

    getChildren() {
        return this._childrenIds.map(id => this._client.getItem(id)).filter(item => item);
    }

    hasChildren() {
        return this._childrenIds.length > 0;
    }

    addChild(position, childId) {
        this._childrenIds.splice(position, 0, childId);
        this.emit('child-added', this._client.getItem(childId), position);
    }

    removeChild(childId) {
        const position = this._childrenIds.indexOf(childId);
        if (position < 0) {
            console.warn("Trying to remove menu child which doesn't exist");
            return;
        }

        this._childrenIds.splice(position, 1);
        this.emit('child-removed', this._client.getItem(childId));
    }

    moveChild(childId, newPosition) {
        const oldPosition = this._childrenIds.indexOf(childId);
        if (oldPosition < 0) {
            console.warn("Trying to move menu child which doesn't exist");
            return;
        }

        if (oldPosition !== newPosition) {
            this._childrenIds.splice(oldPosition, 1);
            this._childrenIds.splice(newPosition, 0, childId);
            this.emit('child-moved', this._client.getItem(childId), oldPosition, newPosition);
        }
    }

    handleEvent(event, data = GLib.Variant.new_int32(0), timestamp = 0) {
        return this._client.sendEvent(this._id, event, data, timestamp);
    }

    sendAboutToShow() {
        this._client.sendAboutToShow(this._id);
    }
}

let dbusMenuInterfaceInfo = null;

/**
 * The client does the heavy lifting of actually reading layouts and distributing events
 */
const DBusClient = GObject.registerClass({
    Signals: {'ready-changed': {}},
}, class AppIndicatorsDBusClient extends DBusProxy {
    _init(busName, objectPath) {
        dbusMenuInterfaceInfo ??= Gio.DBusInterfaceInfo.new_for_xml(Interfaces.DBusMenu);

        super._init(busName, objectPath, dbusMenuInterfaceInfo,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);

        const rootProperties = {'children-display': GLib.Variant.new_string('submenu')};
        this._items = new Map([[0, new DbusMenuItem(this, 0, rootProperties, [])]]);

        // will be set to true if a layout update is needed once active
        this._flagLayoutUpdateRequired = false;
        this._flagItemsUpdateRequired = false;

        // property requests are queued
        this._propertiesRequestedFor = new Set();
        this._propertiesRequest = null;

        this._layoutUpdated = false;
        this._layoutSerial = 0;
        this._active = false;
    }

    async initAsync() {
        await super.initAsync();
        this._requestLayoutUpdate();
    }

    _onNameOwnerChanged() {
        if (this.isReady)
            this._requestLayoutUpdate();
    }

    get isReady() {
        return this._layoutUpdated && !!this.gNameOwner;
    }

    getRoot() {
        return this._items.get(0);
    }

    getItem(id) {
        const item = this._items.get(id);
        if (!item)
            console.warn(`trying to retrieve menu item for non-existing id ${id} !?`);
        return item ?? null;
    }

    _requestLayoutUpdate() {
        this._updateLayout().catch(e => Util.logErrorUnlessCancelled(e));
    }

    // The original implementation will only request partial layouts if somehow
    // possible, we try to save us from multiple kinds of race conditions by
    // always requesting a full layout.
    async _updateLayout() {
        const serial = ++this._layoutSerial;

        try {
            // we only read the type properties, because if the type changes
            // after reading all properties, the view would have to replace
            // the item completely which we try to avoid
            const [, root] = await this.GetLayoutAsync(0, -1, LAYOUT_PROPERTIES,
                this._cancellable);

            // a more recent update is in progress
            if (serial !== this._layoutSerial)
                return;

            this._updateLayoutState(true);
            this._doLayoutUpdate(root);
            this._gcItems();
            this._flagLayoutUpdateRequired = false;
            this._flagItemsUpdateRequired = false;
        } catch (e) {
            if (serial === this._layoutSerial && !Util.isCancelled(e))
                this._updateLayoutState(false);
            throw e;
        }
    }

    _updateLayoutState(state) {
        const wasReady = this.isReady;
        this._layoutUpdated = state;
        if (this.isReady !== wasReady)
            this.emit('ready-changed');
    }

    _doLayoutUpdate([id, properties, children]) {
        const childrenUnpacked = children.map(c => c.deepUnpack());
        const childrenIds = childrenUnpacked.map(([childId]) => childId);

        // make sure all our children exist
        childrenUnpacked.forEach(c => this._doLayoutUpdate(c));

        const menuItem = this._items.get(id);
        if (!menuItem) {
            this._items.set(id, new DbusMenuItem(this, id, properties, childrenIds));
            this._requestProperties(id);
            return;
        }

        // we do, update our properties if necessary
        LAYOUT_PROPERTIES.forEach(name =>
            menuItem.propertySet(name, properties[name] ?? null));

        // make sure our children are all at the right place, and exist
        const oldChildrenIds = menuItem.getChildrenIds();
        childrenIds.forEach((childId, position) => {
            const oldPosition = oldChildrenIds.indexOf(childId);

            if (oldPosition < 0) {
                menuItem.addChild(position, childId);
            } else {
                oldChildrenIds.splice(oldPosition, 1);
                menuItem.moveChild(childId, position);
            }
        });

        // remove any old children that weren't reused
        oldChildrenIds.forEach(childId => menuItem.removeChild(childId));

        if (this._flagItemsUpdateRequired)
            this._requestProperties(id);
    }

    // Removes the cached menu items that are not in the layout anymore
    _gcItems() {
        const usedIds = new Set();
        const toTraverse = [0];

        while (toTraverse.length) {
            const id = toTraverse.pop();
            if (usedIds.has(id))
                continue;

            usedIds.add(id);
            toTraverse.push(...this._items.get(id)?.getChildrenIds() ?? []);
        }

        [...this._items.keys()].forEach(id => {
            if (!usedIds.has(id))
                this._items.delete(id);
        });
    }

    _requestProperties(id) {
        this._requestPropertiesAsync(id).catch(e => {
            if (!Util.isCancelled(e))
                console.warn(`Could not get menu properties: ${e}`);
        });
    }

    async _requestPropertiesAsync(id) {
        this._propertiesRequestedFor.add(id);

        if (this._propertiesRequest?.pending())
            return;

        // if we don't have any requests queued, we'll need to add one
        this._propertiesRequest = new PromiseUtils.IdlePromise(
            GLib.PRIORITY_DEFAULT_IDLE, this._cancellable);
        await this._propertiesRequest;

        const ids = [...this._propertiesRequestedFor];
        this._propertiesRequestedFor.clear();

        // no property names means all the properties
        const [result] = await this.GetGroupPropertiesAsync(ids, [], this._cancellable);
        result.forEach(([itemId, properties]) =>
            this._items.get(itemId)?.replaceProperties(properties));
    }

    set active(active) {
        const wasActive = this._active;
        this._active = active;

        if (!active || wasActive)
            return;

        if (this._flagLayoutUpdateRequired) {
            this._requestLayoutUpdate();
        } else if (this._flagItemsUpdateRequired) {
            this._items.forEach((_item, id) => this._requestProperties(id));
            this._flagItemsUpdateRequired = false;
        }
    }

    _onSignal(_sender, signal, params) {
        // updates are delayed until the menu is opened
        const delayed = !this._active && this.getRoot().hasChildren();

        if (signal === 'LayoutUpdated') {
            if (delayed)
                this._flagLayoutUpdateRequired = true;
            else
                this._requestLayoutUpdate();
        } else if (signal === 'ItemsPropertiesUpdated') {
            if (delayed)
                this._flagItemsUpdateRequired = true;
            else
                this._onPropertiesUpdated(params.deepUnpack());
        }
    }

    // We don't need to cache and burst-send that since it will not happen that frequently
    async sendAboutToShow(id) {
        if (this._hasAboutToShow === false)
            return;

        // Some indicators (you, dropbox!) don't use the right signature
        // and don't return a boolean, so we need to support both cases
        try {
            const reply = await this.gConnection.call(this.gName, this.gObjectPath,
                this.gInterfaceName, 'AboutToShow', new GLib.Variant('(i)', [id]),
                null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
            const replyType = reply.get_type_string();

            if ((replyType === '(b)' && reply.get_child_value(0).get_boolean()) ||
                replyType === '()')
                this._requestLayoutUpdate();
        } catch (e) {
            if (e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) ||
                e.matches?.(Gio.DBusError, Gio.DBusError.FAILED))
                this._hasAboutToShow = false;
            else
                Util.logErrorUnlessCancelled(e);
        }
    }

    async sendEvent(id, event, params, timestamp) {
        if (!this.gNameOwner)
            return;

        try {
            await this.EventAsync(id, event, params, timestamp, this._cancellable);
        } catch (e) {
            if (!Util.isCancelled(e))
                throw e;
        }
    }

    _onPropertiesUpdated([changed, removed]) {
        changed.forEach(([id, properties]) => {
            const item = this._items.get(id);
            Object.entries(properties).forEach(([name, value]) =>
                item?.propertySet(name, value));
        });

        removed.forEach(([id, names]) => {
            const item = this._items.get(id);
            names.forEach(name => item?.propertySet(name, null));
        });
    }
});

// ////////////////////////////////////////////////////////////////////////
// PART TWO: "View" frontend implementation.
// ////////////////////////////////////////////////////////////////////////

// GNOME Shell only tracks one opened submenu per top menu, closing the parent
// of the nested submenus: the client disables that, and the opened submenus
// are tracked by their parent menu instead.
function onSubMenuOpenStateChanged(item, menu, open) {
    // close our own opened submenu
    menu._openedSubMenu?.close({animate: false});
    menu._openedSubMenu = null;

    if (open) {
        // close the sibling submenus
        const parent = menu._parent;
        if (parent._openedSubMenu !== menu) {
            parent._openedSubMenu?.close();
            parent._openedSubMenu = menu;
        }

        item._dbusItem.handleEvent('opened').catch(e => Util.logErrorUnlessCancelled(e));
        item._dbusItem.sendAboutToShow();
    } else {
        item._dbusItem.handleEvent('closed').catch(e => Util.logErrorUnlessCancelled(e));
    }
}

function onActivate(item, event) {
    const dbusItem = item._dbusItem;
    const {indicator} = item._dbusClient;
    const timestamp = event?.get_time() ?? 0;
    const sendClicked = () => dbusItem.handleEvent('clicked', GLib.Variant.new_int32(0),
        timestamp).catch(e => Util.logErrorUnlessCancelled(e));

    if (timestamp && indicator)
        indicator.provideActivationToken(timestamp).catch(logError).finally(sendClicked);
    else
        sendClicked();
}

function updateLabel(item) {
    // remove the mnemonics markers, a double marker is an underscore
    const label = item._dbusItem.propertyGet('label').replace(/_(_?)/g, '$1');
    item.label?.set_text(label);
}

function updateOrnament(item) {
    if (item instanceof PopupMenu.PopupSeparatorMenuItem)
        return;

    const toggleType = item._dbusItem.propertyGet('toggle-type');
    const toggleState = item._dbusItem.propertyGet('toggle-state');

    if (toggleType === 'checkmark' && toggleState)
        item.setOrnament(PopupMenu.Ornament.CHECK);
    else if (toggleType === 'radio')
        item.setOrnament(toggleState ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    else
        item.setOrnament(PopupMenu.Ornament.NONE);
}

async function updateImage(item) {
    if (!item._icon)
        return; // submenus and separators don't have it

    const iconName = item._dbusItem.propertyGet('icon-name');
    const iconData = item._dbusItem.propertyGetVariant('icon-data');

    item._iconCancellable?.cancel();
    item._iconCancellable = null;
    item._icon.visible = !!(iconName || iconData);

    if (iconName) {
        item._icon.icon_name = iconName;
    } else if (iconData) {
        const cancellable = new Gio.Cancellable();
        item._iconCancellable = cancellable;

        try {
            const inputStream = Gio.MemoryInputStream.new_from_bytes(
                iconData.get_data_as_bytes());
            item._icon.gicon = await GdkPixbuf.Pixbuf.new_from_stream_async(
                inputStream, cancellable);
        } catch (e) {
            Util.logErrorUnlessCancelled(e);
        }
    } else {
        item._icon.gicon = null;
    }
}

function updateVisible(item) {
    item.visible = item._dbusItem.propertyGet('visible');
}

function updateSensitive(item) {
    item.setSensitive(item._dbusItem.propertyGet('enabled'));
}

function replaceItem(item) {
    const parent = item._parent;
    const position = parent._getMenuItems().indexOf(item);
    if (position < 0)
        throw new Error("DBusMenu: can't replace non existing menu item");

    // add our new self while we're still alive
    parent.addMenuItem(createItem(item._dbusClient, item._dbusItem), position);
    item.destroy();
}

function moveItemInMenu(menu, dbusItem, position) {
    const item = menu._getMenuItems().find(i => i._dbusItem === dbusItem);
    if (!item)
        return;

    menu.moveMenuItem(item, position);

    // a submenu actor must follow its item
    if (item.menu)
        menu.box.set_child_above_sibling(item.menu.actor, item);
}

function onPropertyChanged(item, name) {
    switch (name) {
    case 'toggle-type':
    case 'toggle-state':
        updateOrnament(item);
        break;
    case 'label':
        updateLabel(item);
        break;
    case 'enabled':
        updateSensitive(item);
        break;
    case 'visible':
        updateVisible(item);
        break;
    case 'icon-name':
    case 'icon-data':
        updateImage(item);
        break;
    case 'type':
    case 'children-display':
        replaceItem(item);
        break;
    default:
        console.debug(`Unhandled menu item property change: ${name}`);
    }
}

function createItem(client, dbusItem) {
    // first, decide whether it's a submenu or not
    let item;
    if (dbusItem.propertyGet('children-display') === 'submenu')
        item = new PopupMenu.PopupSubMenuMenuItem('');
    else if (dbusItem.propertyGet('type') === 'separator')
        item = new PopupMenu.PopupSeparatorMenuItem('');
    else
        item = new PopupMenu.PopupMenuItem('');

    item._dbusItem = dbusItem;
    item._dbusClient = client;

    if (item instanceof PopupMenu.PopupMenuItem) {
        item._icon = new St.Icon({
            style_class: 'popup-menu-icon',
            x_align: Clutter.ActorAlign.END,
        });
        item.add_child(item._icon);
        item.label.x_expand = true;
    }

    // initialize our state
    updateLabel(item);
    updateOrnament(item);
    updateImage(item);
    updateVisible(item);
    updateSensitive(item);

    // the other events change the children, that only submenus can have
    const isSubMenu = item instanceof PopupMenu.PopupSubMenuMenuItem;
    const replaceIfNotSubMenu = callback => (...args) => {
        if (isSubMenu) {
            callback(...args);
        } else {
            console.warn('Tried to change the children of a non-submenu item, recreating it');
            replaceItem(item);
        }
    };

    dbusItem.connectObject(
        'property-changed', (_dbusItem, name) => onPropertyChanged(item, name),
        'child-added', replaceIfNotSubMenu((_dbusItem, child, position) =>
            item.menu.addMenuItem(createItem(client, child), position)),
        'child-removed', replaceIfNotSubMenu((_dbusItem, child) =>
            item.menu._getMenuItems().find(i => i._dbusItem === child)?.destroy()),
        'child-moved', replaceIfNotSubMenu((_dbusItem, child, _oldPosition, newPosition) =>
            moveItemInMenu(item.menu, child, newPosition)),
        item);

    item.connect('activate', (_item, event) => onActivate(item, event));
    item.connect('destroy', () => {
        item._iconCancellable?.cancel();
        item._iconCancellable = null;
        item._dbusItem = null;
        item._dbusClient = null;
        item._icon = null;
    });

    if (isSubMenu) {
        // initially create children
        dbusItem.getChildren().forEach(child =>
            item.menu.addMenuItem(createItem(client, child)));

        item.menu.connectObject('open-state-changed',
            (menu, open) => onSubMenuOpenStateChanged(item, menu, open), item);
    }

    return item;
}

/**
 * Processes DBus events, creates the menu items and handles the actions
 *
 * Something like a mini-god-object
 */
export class Client extends Signals.EventEmitter {
    constructor(busName, path, indicator) {
        super();

        this.indicator = indicator;
        this.cancellable = new Gio.Cancellable();
        this._rootMenu = null; // the shell menu
        this._rootItem = null; // the DbusMenuItem for the root
        this._itemsBeingAdded = new Set();

        this._client = new DBusClient(busName, path);
        this._readyChangedId = this._client.connect('ready-changed',
            () => this.emit('ready-changed'));
        this._client.initAsync().catch(e => Util.logErrorUnlessCancelled(e));
    }

    get isReady() {
        return this._client.isReady;
    }

    // this will attach the client to an already existing menu that will be used as the root menu.
    // it will also connect the client to be automatically destroyed when the menu dies.
    attachToMenu(menu) {
        this._rootMenu = menu;
        this._rootItem = this._client.getRoot();

        // cleanup: remove existing children (just in case)
        menu.removeAll();

        // the opened submenus are tracked by their parent (see onSubMenuOpenStateChanged)
        menu._setOpenedSubMenu = () => {};

        menu.connectObject(
            'open-state-changed', (_menu, open) => this._onMenuOpenStateChanged(open),
            'destroy', () => this.destroy(),
            this);

        this._rootItem.connectObject(
            'child-added', (_item, child, position) => this._onRootChildAdded(child, position),
            'child-removed', (_item, child) => this._onRootChildRemoved(child),
            'child-moved', (_item, child, _oldPosition, newPosition) =>
                moveItemInMenu(menu, child, newPosition),
            this);

        // Dropbox requires us to call AboutToShow(0) first
        this._rootItem.sendAboutToShow();

        // fill the menu for the first time
        this._rootItem.getChildren().forEach(child => this._onRootChildAdded(child));
    }

    _onRootChildAdded(child, position) {
        // Menu additions can be expensive, so let's do it in different chunks
        const basePriority = this._rootMenu.isOpen ? GLib.PRIORITY_DEFAULT : GLib.PRIORITY_LOW;
        const idlePromise = new PromiseUtils.IdlePromise(
            basePriority + this._itemsBeingAdded.size, this.cancellable);
        this._itemsBeingAdded.add(child);

        idlePromise.then(() => {
            if (this._itemsBeingAdded.has(child))
                this._rootMenu.addMenuItem(createItem(this, child), position);
        }).catch(e => Util.logErrorUnlessCancelled(e)).finally(() =>
            this._itemsBeingAdded.delete(child));
    }

    _onRootChildRemoved(child) {
        // children like to play hide and seek
        // but we know how to find it for sure!
        const item = this._rootMenu._getMenuItems().find(i => i._dbusItem === child);

        if (item)
            item.destroy();
        else
            this._itemsBeingAdded.delete(child);
    }

    _onMenuOpenStateChanged(open) {
        this._client.active = open;

        if (open) {
            this._rootMenu._openedSubMenu?.close();
            this._rootItem.handleEvent('opened').catch(e => Util.logErrorUnlessCancelled(e));
            this._rootItem.sendAboutToShow();
        } else {
            this._rootItem.handleEvent('closed').catch(e => {
                // The menu may have been removed at this point, thus do not
                // spam the users about this if it happens.
                if (!e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_OBJECT))
                    Util.logErrorUnlessCancelled(e);
            });
        }
    }

    destroy() {
        if (!this._client)
            return;

        this.cancellable.cancel();
        this._rootMenu?.disconnectObject(this);
        this._rootItem?.disconnectObject(this);
        this._client.disconnect(this._readyChangedId);
        this._client.destroy();
        this.disconnectAll();

        this._client = null;
        this._rootItem = null;
        this._rootMenu = null;
        this.indicator = null;
        this._itemsBeingAdded.clear();
    }
}
