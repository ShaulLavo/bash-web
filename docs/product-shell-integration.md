# Editor and terminal release integration

`tests/product-shell.spec.ts` mounts the installed public Singapore editor,
Ghostty terminal, and bash-web session on one borrowed Waffle runtime. It runs as
part of the blocking browser suite. `build:browser:assets:ci` prepares its separate
test page after the ordinary demo build, reusing the native job's shell guest.

The test clicks the editor, types a script, replaces a keyboard selection, and
deletes a character. Saving writes exactly the editor text to Waffle. Native
browser keyboard input then runs `source /workspace/smoke.sh` through Ghostty's
`onData` event bytes. Assertions require a distinct output line, a successful
prompt, and no terminal input or output when typing back in the editor. After
disposing both views and their session, a file round trip and a second shell
prove that the page still owns a usable runtime. The page disposes it last.

## Package selection

Test-only dependencies use public GitHub release archive URLs. Both lockfiles
record their integrity. The `bash-web-public` and `ghostty-public` install names
keep this fixture separate from the demo's protected Ghostty source pin.

| Package                                    | Public release                                       |
| ------------------------------------------ | ---------------------------------------------------- |
| Singapore core 0.2.10 and textbuffer 0.2.9 | `singapore-f0402824ffedcbd5087844adde151e0592aab04e` |
| Ghostty 0.3.33                             | `v0.3.33-ab50008`                                    |
| bash-web adapter and workers 0.0.110       | `bash-web-v0.0.110`                                  |
| Waffle 0.0.129                             | `waffle-v0.0.129`, host interface 2                  |

The guest is the ordinary workspace build, not a Wasm asset in the bash-web
archive. At introduction, workspace source `e5a87cc4` is the exact 0.0.110 release
source. Later runs pair the pinned public adapter with the current workspace
guest. Change the test dependency URLs and regenerate both lockfiles when
qualifying a newer public tuple. Do not change `sources.lock.json` for this test.

After the normal browser build, run `npm run test:browser:integration`. The same
case runs in every configured Playwright project. It uses the textarea editor
input route and Ghostty's Canvas renderer. WebKit is desktop engine coverage.
This check does not establish native iPhone input, IME, clipboard, WebGPU, or the
components' complete editor and terminal suites.
