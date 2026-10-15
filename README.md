Net Speed
=========

Show current net speed on panel.
--------------------------------

This extension is inspired by <https://github.com/biji/simplenetspeed/> which has some annoying flickers existing for a long time so I decide to create my own alternative. I removed all features that I won't use.

It only shows text like `↓ 777 K/s ↑ 2.33 K/s` on the right part of panel. No font size changing, no total downloaded bytes, no bits.

# Usage

```
$ git clone https://github.com/AlynxZhou/gnome-shell-extension-net-speed.git
$ cd gnome-shell-extension-net-speed
$ gnome-extensions pack --force
$ gnome-extensions install --force netspeed@alynx.one.shell-extension.zip
```

or install it from <https://extensions.gnome.org/extension/4478/net-speed/>.

Then log out and log in again (GNOME Shell on Wayland cannot be restarted in place), and enable Net Speed with `gnome-extensions enable netspeed@alynx.one` or from GNOME Extensions.
