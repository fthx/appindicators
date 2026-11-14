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

// D-Bus interfaces, reduced to what is actually used.
//
// The proxied interfaces (StatusNotifierItem, DBusMenu) must not declare any
// signal, otherwise gjs would turn them into JS signals: they are handled from
// the 'g-signal' signal instead. Undeclared properties (the optional ones, such
// as XAyatanaLabel) are still cached by the proxy, without type checking.

// Based on https://invent.kde.org/frameworks/knotifications/-/blob/master/src/org.kde.StatusNotifierItem.xml
export const StatusNotifierItem = `<node>
<interface name="org.kde.StatusNotifierItem">
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <method name="Activate">
        <arg name="x" type="i" direction="in"/>
        <arg name="y" type="i" direction="in"/>
    </method>
    <method name="SecondaryActivate">
        <arg name="x" type="i" direction="in"/>
        <arg name="y" type="i" direction="in"/>
    </method>
    <method name="XAyatanaSecondaryActivate">
        <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="ProvideXdgActivationToken">
        <arg name="token" type="s" direction="in"/>
    </method>
    <method name="Scroll">
        <arg name="delta" type="i" direction="in"/>
        <arg name="orientation" type="s" direction="in"/>
    </method>
</interface>
</node>`;

export const StatusNotifierWatcher = `<node>
<interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
        <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
        <arg name="service" type="s" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
</interface>
</node>`;

// AboutToShow is called directly, as some implementations use a wrong signature
export const DBusMenu = `<node>
<interface name="com.canonical.dbusmenu">
    <method name="GetLayout">
        <arg type="i" name="parentId" direction="in"/>
        <arg type="i" name="recursionDepth" direction="in"/>
        <arg type="as" name="propertyNames" direction="in"/>
        <arg type="u" name="revision" direction="out"/>
        <arg type="(ia{sv}av)" name="layout" direction="out"/>
    </method>
    <method name="GetGroupProperties">
        <arg type="ai" name="ids" direction="in"/>
        <arg type="as" name="propertyNames" direction="in"/>
        <arg type="a(ia{sv})" name="properties" direction="out"/>
    </method>
    <method name="Event">
        <arg type="i" name="id" direction="in"/>
        <arg type="s" name="eventId" direction="in"/>
        <arg type="v" name="data" direction="in"/>
        <arg type="u" name="timestamp" direction="in"/>
    </method>
</interface>
</node>`;
