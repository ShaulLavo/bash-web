# Terminal controls

The standalone browser demo has Paste, previous/next history, and left/right cursor buttons below its existing Ghostty terminal. They stay available at every viewport width, including desktop-request browsing and devices with a trackpad. Each button has an accessible name and a target of at least 44 by 44 CSS pixels.

Paste reads the clipboard and focuses terminal input in the click gesture. Ghostty's `paste()` preserves its bracketed-paste and newline rules; `key()` encodes arrows using the active cursor mode. Compatibility `mousedown` cancels the button's focus change, while `pointerdown` and `click` remain available. Keyboard users can Tab to a button and activate it with Enter or Space.

Unavailable, denied and empty clipboard reads produce a short live notice that clears after five seconds. There is one pending read at a time, and a read from a stopped or restarted session cannot reach the replacement session. The system Paste menu and desktop keyboard input remain available.

The bar participates in normal flex layout. Visual viewport changes, including software keyboard space, change the workbench height. Below 540 CSS pixels of visual viewport height the page drops its footer and tightens the toolbars. The terminal keeps about three rows; a viewport too short for that scrolls instead of hiding the terminal. The existing Ghostty fit observer and `onResize` forwarding continue to own terminal geometry and Waffle resize notifications. Focus and attachment do not set geometry.

These are bash-web demo controls, not Waffle core or a new shell API. OS clipboard prompts and software keyboard visibility require native Safari qualification. Browser touch emulation does not establish physical iPhone or iPad support; no iPad qualification is claimed.

`tests/terminal-controls.spec.ts` checks real Ghostty output bytes in both cursor and paste modes, shell history/editing, clipboard errors and stale reads, mouse compatibility, accessible target sizes, and viewport fitting. The clipboard boundary is simulated; the terminal and shell are real.
