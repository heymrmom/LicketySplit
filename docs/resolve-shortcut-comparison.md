# LicketySplit / DaVinci Resolve keyboard comparison

Checked 2026-10-09 against the installed macOS DaVinci Resolve **21.1.0** app bundle (`21.1.00014`) and its September 2026 Resolve 21.1 Reference Manual. The official [Blackmagic Design Support Center](https://www.blackmagicdesign.com/support) lists the 21.1 manual; the direct [21.1 Reference Manual PDF](https://documents.blackmagicdesign.com/UserManuals/DaVinci_Resolve_21.1_Reference_Manual.pdf) is the source for the page references below.

The Resolve keymap is customizable. The app owner’s active Resolve keymap was not read or refreshed: the owner app was unavailable in the connected app inventory, and this comparison did not launch it. Likewise, no owner LicketySplit profile or browser storage was read. The LicketySplit columns report code defaults plus the named DaVinci preset, not an unverified owner-active customization. Runtime tests use isolated Vitest storage and registered handlers.

## Common actions

| Action | LicketySplit default | Resolve 21.1 macOS default | DaVinci preset / result |
| --- | --- | --- | --- |
| Play / pause | Space | Space; J/K/L also provide reverse/stop/forward transport | Space matches; J/K/L are unsupported |
| Step one frame | Left / Right | Left / Right | Same |
| Step one second | Shift+Left / Shift+Right | Shift+Left / Shift+Right | Same |
| Previous / next edit | [ / ]; Up / Down jump 5 seconds | Up / Down previous / next edit | DaVinci preset maps Up / Down to seek neighboring item edges; it does not select the edit point |
| Split at playhead | S | Cmd+Backslash | Cmd+Backslash; supported split action |
| Trim start / end to playhead | Q / W | Shift+[ / Shift+] | Shift+[ / Shift+]; supported |
| Delete leaving a gap | Delete | Delete | Same |
| Ripple delete | Shift+Delete | Forward Delete | Different binding; preset leaves LicketySplit’s Shift+Delete action intact |
| Undo / redo | Cmd+Z / Cmd+Shift+Z | Cmd+Z / Cmd+Shift+Z | Same |
| Toggle snapping | N | N | Same |
| Timeline zoom in / out | Cmd+= / Cmd+- | Cmd+= / Cmd+- | Same |
| Full timeline overview / restore | Cmd+0 | Shift+Z | Shift+Z; implemented as a toggle that also keeps fitting after resize/content changes |
| Add marker at playhead | M | M | Same |
| Save project | Cmd+S | Cmd+S | Same |

The desktop and browser Keyboard Shortcuts dialog has a searchable “Resolve 21.1 comparison” view with the same action/default/status/behavior fields. Its LicketySplit column reads the current app keymap when the dialog opens and refreshes if bindings change. Compatibility is calculated from the current binding and the verified Resolve default; the DaVinci preset therefore changes rows to “Same” when it applies the canonical key. An empty binding displays “Unassigned” and is “Different.” Native-menu-only New Project and Open Project are marked as such and are not described as shortcut-manager bindings. The overview button is beside the zoom controls; its accessible name and tooltip show the current fit/restore action and live binding. The desktop shell mounts this same dialog. The isolated full-hour desktop walkthrough opened its searchable comparison, verified that Space remained text input in its search field, and exercised Cmd+0 overview/detail toggling. Native menu and renderer focus regressions are covered separately; this does not establish every shortcut through a physical keyboard.

## Complete action table

“LicketySplit default” is the built-in binding in `keyboard-shortcuts.ts`. “Resolve default” reflects the installed Resolve 21.1 manual and macOS terminology. The status column below describes those built-in LicketySplit bindings; the in-app table recalculates it from the current keymap. “No verified default” means the reviewed manual did not document a matching default for that action; it does not prove that no user could create one in Resolve’s customizable keymap.

| Action | LicketySplit binding | Resolve default | Status | Behavior notes |
| --- | --- | --- | --- | --- |
| Play / pause | Space | Space | Same | LicketySplit toggles transport. |
| Frame back / forward | Left / Right | Left / Right | Same | Frame duration uses the current project frame rate. |
| Second back / forward | Shift+Left / Shift+Right | Shift+Left / Shift+Right | Same | Both seek one second. |
| Jump back / forward 5 seconds | Up / Down | Up / Down = previous / next edit | Different | The DaVinci preset reuses Up/Down for the compatible seek-to-previous/next-edge handlers; it does not select an edit point. |
| Go to timeline start / end | Home / End | Home / End | Same | Resolve describes first/last frame of the Source or Timeline Viewer. |
| Previous / next clip edge | [ / ] | Up / Down = previous / next edit | Different | Default bindings differ. The DaVinci preset maps these actions to Up/Down, seeking neighboring item edges without selecting the edit point. |
| Mark loop start / end | I / O | I / O set In / Out points | Different | LicketySplit marks a preview loop; Resolve changes edit/viewer In/Out points. |
| Toggle preview loop | Shift+L | Cmd+/ | Different | Resolve’s L transport is not a loop toggle; the verified Cmd+/ loop binding is not LicketySplit’s current Shift+L default. |
| Undo / redo | Cmd+Z / Cmd+Shift+Z | Cmd+Z / Cmd+Shift+Z | Same | — |
| Cut selected clips | Cmd+X | Cmd+X | Same | Both leave a gap. Resolve also offers Cmd+Shift+X for ripple cut; LicketySplit has no matching ripple-cut action. |
| Copy / paste | Cmd+C / Cmd+V | Cmd+C / Cmd+V | Same | Paste destination/selection behavior differs by editor. |
| Duplicate selected clip | Cmd+D | Cmd+D changes clip duration | Different | The DaVinci preset does not override this LicketySplit command, so Cmd+D still duplicates in that preset. |
| Delete leaving a gap | Delete | Delete | Same | On macOS, the physical Delete key may report `Backspace`; the runtime normalizes it. |
| Ripple delete | Shift+Delete | Forward Delete | Different | LicketySplit retains Shift+Delete. Its ripple handler currently covers selected media clips; Resolve’s Forward Delete operates according to enabled track/sync-lock settings. |
| Split clip at playhead | S | Cmd+Backslash | Different | The DaVinci preset maps Cmd+Backslash to this action. |
| Trim start / end to playhead | Q / W | Shift+[ / Shift+] | Different | The DaVinci preset applies the Resolve-compatible Shift-bracket bindings. |
| Select all clips | Cmd+A | Cmd+A | Same | The Resolve manual also documents context-specific Select All behavior. |
| Deselect | Escape | Cmd+Shift+A | Different | The DaVinci preset maps the supported clear-selection action to Cmd+Shift+A. |
| Toggle snapping | N | N | Same | — |
| Timeline zoom in / out | Cmd+= / Cmd+- | Cmd+= / Cmd+- | Same | Both zoom controls are playhead-oriented in Resolve; LicketySplit currently changes scale without matching Resolve’s exact anchor behavior. |
| Fit timeline / restore prior zoom | Cmd+0 | Shift+Z | Different | The DaVinci preset maps Shift+Z. LicketySplit stays fitted through viewport/content changes while overview is active. |
| Show shortcut help | ? | No verified default | Not compared | LicketySplit has an in-app overlay; absence from the reviewed manual does not establish unsupported Resolve capability. |
| Save project | Cmd+S | Cmd+S | Same | Resolve also documents Save As, which has no LicketySplit shortcut action. |
| Export | Cmd+E | No verified default | Not compared | LicketySplit opens its export modal; absence from the reviewed manual does not establish unsupported Resolve capability. |
| Add text clip | T | No verified default | Not compared | No matching Resolve default was found in the reviewed manual. |
| Add marker at playhead | M | M | Same | Resolve also documents Command+M to add/edit a marker while playback continues. |
| New project | Cmd+N (native menu) | No verified default | Not compared | Resolve documents Cmd+N for New Timeline, not New Project. |
| Open project | Cmd+O (native menu) | No verified default | Not compared | No matching Resolve default was verified in the reviewed manual. |
| Blade tool | No blade-mode action; S splits selected clips at playhead | B enters Blade Edit Mode | Unsupported | Cmd+Backslash is the compatible Resolve “Split Clips” command; pointer-based blade mode is not implemented. |
| J/K/L transport | No J/K/L actions | J reverse, K stop, L forward | Unsupported | LicketySplit provides Space play/pause and frame/second stepping only. |

## Runtime and focus evidence

- The keyboard service registers handlers for every action shown with a LicketySplit default in the table. The DaVinci preset updates only its compatible bindings and keeps LicketySplit defaults for the rest; it does not claim full Resolve emulation.
- Isolated runtime tests dispatch the Cmd+Backslash split, Shift+Z fit toggle, Shift-bracket trim, arrow navigation, plus-key zoom, and physical punctuation keys. Focus tests confirm that inputs, editable text, sliders, dialogs, native buttons, and modal dialogs keep their expected typing/navigation behavior. A focused timeline clip retains frame navigation.
- Custom key changes, clearing a binding, and preset changes notify subscribers; the viewport tooltip re-renders from the current fit binding. The integrated `97d066b` development build preserved a synthetic custom Cmd+9 fit binding and mapped the old default preset to LicketySplit Default. Normal keyboard input toggled the actual overview control, and shortcut help displayed Cmd+9. The source keys remained intact; see the branding migration research report for receipts. This synthetic profile does not establish the owner’s current customizations.
- The owner’s current active LicketySplit/Resolve customizations remain unknown and unrefreshed. Do not present this default/preset comparison as a read of either user profile.

## Manual page references

Installed Resolve 21.1 Reference Manual: timeline zoom and Shift-Z toggle, pp. 828, 851; playback, frame/second stepping, edit navigation, Home/End, I/O, JKL, and markers, pp. 870–871; select-all and command list, pp. 889, 942; trim, blade, cut, and delete command table, pp. 942–943. The installed app bundle version was read from its `Info.plist`; the app was not launched.
