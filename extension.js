/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from "gi://GObject";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Clutter from "gi://Clutter";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import {Extension} from "resource:///org/gnome/shell/extensions/extension.js";

const refreshInterval = 3;
const speedUnits = [
  "B/s", "K/s", "M/s", "G/s", "T/s", "P/s", "E/s", "Z/s", "Y/s"
];
// `ifb`: Created by python-based bandwidth manager "traffictoll".
// `lxdbr`: Created by lxd container manager.
// VPN interfaces (`tun`, `wg`, `tailscale`, `zt`...) are skipped because their
// traffic is also counted on the physical interface.
// Add more virtual interface prefixes here.
const virtualIfacePrefixes = [
  "lo", "ifb", "lxdbr", "virbr", "br", "vnet", "tun", "tap", "docker", "utun",
  "wg", "veth", "vboxnet", "vmnet", "tailscale", "zt", "podman", "cni",
  "flannel", "cali"
];

const isVirtualIface = (name) => {
  return virtualIfacePrefixes.some((prefix) => {
    return name.startsWith(prefix);
  });
};

const formatSpeedWithUnit = (amount) => {
  let unitIndex = 0;
  while (amount >= 1000 && unitIndex < speedUnits.length - 1) {
    amount /= 1000;
    ++unitIndex;
  }

  let digits = 0;
  // Instead of showing 0.00123456 as 0.00, show it as 0.
  if (amount >= 100 || amount < 0.01) {
    // 100 M/s, 200 K/s, 300 B/s.
    digits = 0;
  } else if (amount >= 10) {
    // 10.1 M/s, 20.2 K/s, 30.3 B/s.
    digits = 1;
  } else {
    // 1.01 M/s, 2.02 K/s, 3.03 B/s.
    digits = 2;
  }

  // See <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Number/toFixed>.
  return `${amount.toFixed(digits)} ${speedUnits[unitIndex]}`;
};

const toSpeedString = (speed) => {
  return `↓ ${formatSpeedWithUnit(speed["down"])} ↑ ${formatSpeedWithUnit(speed["up"])}`;
};

// Parse `/proc/net/dev` into a map of interface name to byte counters.
//
// Lines look like `  eth0: 123 456 ...`. Interface names may contain `-`, `.`
// or `@` (like `br-1a2b3c` or `eth0.100`) but never `:`, so split on the first
// `:` instead of on non-word characters. Also there may be no space between
// `:` and the first number.
const parseNetDev = (text) => {
  const ifaces = new Map();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/);
    // 8 receive fields, then 8 transmit fields.
    if (name.length === 0 || fields.length < 16) {
      continue;
    }
    const down = Number.parseInt(fields[0], 10);
    const up = Number.parseInt(fields[8], 10);
    if (Number.isNaN(down) || Number.isNaN(up)) {
      continue;
    }
    ifaces.set(name, {down, up});
  }
  return ifaces;
};

const Indicator = GObject.registerClass(
  class Indicator extends PanelMenu.Button {
    _init() {
      // `menuAlignment`, `nameText`, `dontCreateMenu`.
      super._init(0.0, "Net Speed", true);

      this._label = new St.Label({
        "style_class": "netspeed-label",
        "y_align": Clutter.ActorAlign.CENTER,
        "text": toSpeedString({"down": 0, "up": 0})
      });

      this.add_child(this._label);
    }

    setText(text) {
      return this._label.set_text(text);
    }
  });

export default class NetSpeed extends Extension {
  enable() {
    this._textDecoder = new TextDecoder();
    this._netDevFile = Gio.File.new_for_path("/proc/net/dev");
    // Counters of each interface and time of last sample, so we can compute
    // per-interface deltas and handle interfaces appearing, disappearing or
    // resetting their counters without showing huge or negative spikes.
    this._lastIfaces = null;
    this._lastTime = 0;

    this._indicator = new Indicator();
    // `role`, `indicator`, `position`, `box`.
    // `-1` is not OK for position, it will show at the right of system menu.
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, "right");

    // Take an initial sample so the first refresh already shows real speed.
    this.getCurrentNetSpeed();
    this._timeout = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT, refreshInterval, () => {
        const speed = this.getCurrentNetSpeed();
        this._indicator.setText(toSpeedString(speed));
        // Run as loop, not once.
        return GLib.SOURCE_CONTINUE;
      }
    );
  }

  disable() {
    if (this._timeout != null) {
      GLib.source_remove(this._timeout);
      this._timeout = null;
    }
    if (this._indicator != null) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._textDecoder = null;
    this._netDevFile = null;
    this._lastIfaces = null;
  }

  getCurrentNetSpeed() {
    const speed = {"down": 0, "up": 0};

    try {
      const [, content] = this._netDevFile.load_contents(null);
      // `ByteArray` is deprecated with ES Module, standard JavaScript
      // `TextDecoder` should be used here.
      const ifaces = parseNetDev(this._textDecoder.decode(content));
      // Timers are not precise, especially when system is busy, so measure
      // the real elapsed time instead of assuming `refreshInterval`.
      const now = GLib.get_monotonic_time();

      if (this._lastIfaces != null) {
        const elapsed = (now - this._lastTime) / GLib.USEC_PER_SEC;
        let down = 0;
        let up = 0;
        for (const [name, iface] of ifaces) {
          const last = this._lastIfaces.get(name);
          // Skip new interfaces and those whose counters went backwards
          // (re-created or reset), they will be counted from next sample.
          if (isVirtualIface(name) || last == null) {
            continue;
          }
          if (iface.down >= last.down) {
            down += iface.down - last.down;
          }
          if (iface.up >= last.up) {
            up += iface.up - last.up;
          }
        }
        if (elapsed > 0) {
          speed["down"] = down / elapsed;
          speed["up"] = up / elapsed;
        }
      }

      this._lastIfaces = ifaces;
      this._lastTime = now;
    } catch (e) {
      console.error(e);
    }

    return speed;
  }
};
