# Effects

Per-channel and master effects, built from small self-describing modules. The
engine, the mixer panel and the automation editor all read one registry, so a
new effect is one file and one `<script>` tag. See [automation](automation.md)
for lanes and [sequencer API](sequencer-api.md) for the engine around this.

## Files

- `static/js/effects/EffectRegistry.js` (registration and validation)
- `static/js/effects/distortion.js`, `compressor.js`, `limiter.js`, `delay.js`, `reverb.js`
- `SequencerEngine` (hosts effect instances, mix state, master channel)
- `static/js/sequencer-ui.js` (mixer panel and automation editor, both generated from the registry)

Load the registry first. The other effect files can be in any order, because
they are sorted by `order`. All of them load **before** `sequencer-ui.js`, which
constructs the engine; the engine reads the registry in its constructor.

```html
<script src="/js/effects/EffectRegistry.js"></script>
<script src="/js/effects/distortion.js"></script>
<script src="/js/effects/compressor.js"></script>
<script src="/js/effects/limiter.js"></script>
<script src="/js/effects/delay.js"></script>
<script src="/js/effects/reverb.js"></script>
```

## Signal flow

Every channel (MIDI track, audio lane) and the master get a strip:

```
source -> gain -> filter -> [inserts, by order] -> pan -> out
                                                    +-> [sends] -> out
```

- `gain` is the strip's entry point and the channel's volume. Sources and
  instrument voices connect to it.
- `filter` and `pan` are built in. The filter's type switch and cutoff remapping
  are special-cased in the engine, so it is not a module.
- **Inserts** run in series between the filter and pan, sorted by `order`
  (lowest first).
- **Sends** are parallel taps off `pan`. Each send's output rejoins the strip's
  `out`, so a send follows the channel's volume, filter and pan.
- For lanes, `out` is the lane's mute node, so muting a lane also silences its
  effect tails. For the master, `out` is `audioContext.destination`.
- `engine.masterGain` is the master strip's `gain` node, so everything that
  connects to it (lanes, the pattern preview) passes through the master filter,
  inserts and pan. Master volume sits before the chain, so a limiter catches
  whatever the master volume pushes into it.

## Module contract

```js
JukeBoxEffects.register({
    id: 'tremolo',               // lowercase, unique
    label: 'Tremolo',            // shown in the mixer and automation lists
    kind: 'insert',              // 'insert' (in series) or 'send' (parallel tap)
    order: 30,                   // position among inserts; default 50
    scopes: ['channel'],         // 'channel', 'master', or both; default ['channel']
    params: { /* see below */ },
    isActive: (mix) => mix.tremDepth > 0,
    create(env, mix) { /* build nodes */ return { input, output, nodes, targets } }
});
```

`create(env, mix)` returns:

| Field | Required | Purpose |
| --- | --- | --- |
| `input` | yes | Node the engine connects the chain (inserts) or the pan tap (sends) into. |
| `output` | yes | Node the engine connects onward. May be the same node as `input`. |
| `nodes` | yes | Every node the module created. They are disconnected when the channel is disposed. |
| `targets(key)` | yes | The `AudioParam`s behind a stored value: `[{ param, map? }]`. `map` converts the stored value to the node value (for example dB to linear gain). Return `[]` for keys that are not yours. |
| `apply(values, env, immediate)` | no | Defaults to pushing every key through `targets()`. Override only for extra work. |
| `onTempoChange(mix, env)` | no | Called when BPM changes. Used by tempo-synced effects (delay). |
| `dispose()` | no | Stop oscillators or LFOs. Nodes in `nodes` are disconnected separately. |

`env` is everything a module is allowed to touch. It never sees the engine:

| Field | Meaning |
| --- | --- |
| `context` | The `AudioContext`. Create nodes with it, never from a global. |
| `shared` | A `Map` shared by every instance in this engine. Use it for expensive resources (the reverb impulse). |
| `bpm()` | Current base BPM. |
| `smooth(param, value)` | Click-free change (15 ms time constant). |
| `set(param, value)` | Immediate change. |

### Parameters

`params` is a flat object, keyed by name. Keys are camelCase, unique across all
modules, and cannot be `volume`, `pan`, `cutoff`, `resonance`, `filterType` or
`tempo`. Keys stay flat so saved projects keep working.

| Field | Meaning |
| --- | --- |
| `label` | Short UI label. |
| `min`, `max`, `def` | Numeric range and default. `min < max`, and `def` must be inside the range. |
| `step` | Slider step. Default 0.01. |
| `format` | One of `percent`, `pan`, `hz`, `db`, `seconds`, `ratio`, `beats`, `bpm`, `number`. |
| `log` | Log-scaled slider, and exponential automation ramps. Needs `min > 0`. |
| `automatable` | Offer a lane for this parameter. |

The registry validates every module on registration and throws a descriptive
`TypeError` for a bad id, kind, scope, duplicate key, bad range or missing
function, so a broken module fails at load, not during playback.

## How the engine hosts effects

- **Lazy creation.** A channel's effect nodes are created the first time
  `isActive(mix)` is true, or the first time automation needs them. Channels
  that never use an effect pay nothing for it.
- **Nodes stay.** Once created, an effect stays in the chain until the channel is
  deleted. Setting a mix back to "off" does not remove it. Note that
  `isActive` is not re-checked: a compressor set back to ratio 1 is still in the
  chain, so its makeup gain still applies.
- **Splicing.** Creating an insert reconnects `filter -> inserts -> pan` in
  `order`. This can click once if it happens during playback; turn effects on
  before playing if that bothers you.
- **Scopes.** `setChannelParam` returns `false` for a parameter whose module does
  not allow that channel type (for example `delaySend` on the master), and the UI
  only lists parameters the channel supports.
- **Mix state lives in the engine**, separate from the nodes, so it survives
  track removal and undo, and can be set before the `AudioContext` exists.
- **Smoothing.** Slider changes go through `smooth()`. They also affect notes that
  are already sounding, since a channel's voices share one strip.

### The master channel

The master is the channel ID `'master'`. It has the same strip as a lane, with
scope `'master'`:

- Core params: volume (default 0.7, the old `MASTER_GAIN`), pan, filter.
- Effects whose `scopes` include `'master'`: distortion, compressor, limiter.
- Sends (delay, reverb) are channel-only.
- It appears as the first row of the mixer panel and the first entry of the
  automation channel list.
- `New Sequence` resets the master mix, and loading a project without a master
  mix gives defaults.

## Engine API

```js
engine.paramCatalog(id)                  // [{ id, label, kind?, params: [{ key, label, min, max, def, step, format, log, automatable }] }]
engine.effectActive(id, moduleId)        // is that effect currently active for the channel?
engine.hasChannel(id)

engine.setChannelParam(id, key, value)   // true if accepted; smoothed, safe during playback
engine.setChannelVolume(id, value)       // shorthand for 'volume'
engine.setChannelPan(id, value)          // shorthand for 'pan'
engine.setChannelFilterType(id, type)    // 'lowpass' | 'highpass'
engine.resetChannelParam(id, key)
engine.getChannelMix(id)                 // complete mix object, defaults filled in
engine.applyChannelMix(id, mix)          // applies recognised keys, ignores the rest
engine.extractMix(source)                // picks the valid mix values out of a saved object
engine.resetChannelMix(id)

engine.snapshotMix()                     // { master, tracks: [{ trackId, ...mix }] }
engine.restoreMix(state)
```

`setChannelParam` returns `false` for an unknown parameter, a non-finite value,
an unknown channel, or a parameter outside the channel's scope. Values are
clamped to the parameter's range.

## Automation integration

Modules do not touch the scheduler. For every automated parameter the engine
calls `targets(key)`, applies `map` if present, and schedules `setValueAtTime`
plus a ramp per 16th step (exponential for `log` parameters whose values are
positive, linear otherwise). On Stop and Pause the engine pushes each stored mix
value back through the same `apply` path, so sliders take over again.

`engine.automationParams(id)` returns the automatable parameters for a channel
(core, then each effect valid for it). The master additionally offers **Tempo**.

### Tempo automation

A Tempo lane exists on the master only. It is compiled into `sequence.tempos` as
a staircase, one event per 16th step (or per stride on very long lanes, capped at
2048 events), so playback and export use the existing tempo-map code.

- Editing a tempo lane is allowed only while stopped.
- An imported tempo map is protected: a lane cannot be drawn over it.
- While a Tempo lane exists, `setBpm()` throws and the BPM field is disabled.
  Clearing the lane restores a constant tempo using the base BPM.
- Loading a project does not recompile the tempo lane, since the saved tempo map
  already contains the result. The base BPM is taken from the map's first event.
- Tempo-synced effects (delay times) follow the **base** BPM, not the automated
  tempo.

## Persistence

Nothing about the format is module-specific: every key in `#specs` is saved.

- `instruments.mixer` is `{ master: {...mix}, tracks: [{ trackId, ...mix }] }`.
  Each mix object holds `filterType` plus every core and effect key.
- Automation lanes go in `instruments.automation` as before. A lane may now use
  `channelId: 'master'` and, for tempo, `key: 'tempo'`.
- Projects saved before this change have no `master` entry and no new keys. They
  load with defaults, and every new effect defaults to **off** (distortion mix 0,
  compressor ratio 1, limiter ceiling 0 dB).
- `applyChannelMix` and `restoreMix` ignore unknown keys, so removing a module
  never breaks loading an older save.

## Built-in effects

| Effect | Kind | Order | Scope | Parameters (range, default) | Off when |
| --- | --- | --- | --- | --- | --- |
| Distortion | insert | 10 | channel, master | `distDrive` 0-1 (0.4), `distTone` 500-20000 Hz log (20000), `distMix` 0-1 (0) | `distMix` = 0 |
| Compressor | insert | 20 | channel, master | `compThreshold` -60-0 dB (-18), `compRatio` 1-20 (1), `compAttack` 1-500 ms log (10 ms), `compRelease` 20-1000 ms log (250 ms), `compMakeup` 0-24 dB (0) | `compRatio` = 1 |
| Limiter | insert | 100 | master | `limThreshold` -24-0 dB (0), `limRelease` 10-1000 ms log (100 ms) | `limThreshold` = 0 |
| Delay | send | 50 | channel | `delaySend` 0-1 (0), `delayBeats` 0.125-2 (0.75), `delayFeedback` 0-0.9 (0.4) | `delaySend` = 0 |
| Reverb | send | 60 | channel | `reverbSend` 0-1 (0) | `reverbSend` = 0 |

Automatable: every parameter except `compAttack`, `compRelease`, `limRelease` and
`delayBeats`.

- **Distortion**: a tanh waveshaper with 4x oversampling, a tone filter, and a
  dry/wet mix. Output is level-compensated so raising Drive does not jump in
  loudness.
- **Compressor and limiter**: both are `DynamicsCompressorNode`s. The limiter is a
  fast, hard-ratio compressor (ratio 20, knee 0, 1 ms attack), not a true
  brickwall. It has about 6 ms of built-in lookahead, so peaks can overshoot
  slightly and every compressed channel is a few ms late against the others
  (there is no delay compensation).
- **Delay**: time is in beats (default is a dotted eighth) and retimes on BPM
  changes. Each repeat passes through a 4 kHz low-pass. Maximum delay is 4 s.
- **Reverb**: a decaying-noise impulse (2 s) generated once and shared by every
  channel. Each channel has its own send level, but reverb size is fixed.

## Writing a new effect

1. Create `static/js/effects/<name>.js` and call `JukeBoxEffects.register(...)`.
2. Wrap the file in an IIFE. Classic scripts share one global scope, so a
   top-level `const` with the same name in two files is a `SyntaxError`.
3. Pick `kind`, `order` and `scopes`. Inserts go in series, so choose `order` to
   fit with the others (the limiter is 100 so it stays last).
4. Give every param a unique camelCase key, a range, and a **default that
   leaves the effect off**, so existing projects sound the same.
5. Build nodes only with `env.context`. Do not import anything from the engine.
   Keep the nodes in `nodes`, and stop any oscillators in `dispose()`.
6. Implement `targets(key)`. Use `map` for unit conversions.
7. Add one `<script>` tag. Nothing else changes: the mixer row, the automation
   list and the saved format all follow the registry.

```js
(() => {
    JukeBoxEffects.register({
        id: 'tremolo', label: 'Tremolo', kind: 'insert', order: 30, scopes: ['channel'],
        params: {
            tremDepth: { label: 'Depth', min: 0, max: 1, def: 0, step: 0.01, format: 'percent', automatable: true },
            tremRate: { label: 'Rate', min: 0.5, max: 20, def: 5, step: 0.1, format: 'number' }
        },
        isActive: (mix) => mix.tremDepth > 0,
        create({ context }) {
            const amp = context.createGain();
            const lfo = context.createOscillator();
            const depth = context.createGain();
            lfo.connect(depth).connect(amp.gain);
            lfo.start();
            return {
                input: amp, output: amp, nodes: [amp, lfo, depth],
                dispose: () => { try { lfo.stop(); } catch (_) {} },
                targets: (key) => key === 'tremDepth' ? [{ param: depth.gain, map: (d) => d / 2 }]
                    : key === 'tremRate' ? [{ param: lfo.frequency }] : []
            };
        }
    });
})();
```

## Mixer and automation UI

- The mixer panel builds each row from `engine.paramCatalog(id)`. Volume and pan
  are inline, then the filter, then one collapsible section per effect. A section
  is bold while its effect is active.
- Rows are rebuilt only when the channel list changes (tracks added, removed,
  renamed or reordered). Otherwise sliders just refresh, and a slider being
  dragged is never overwritten.
- Double-click any slider to reset it. Log parameters use a 0-1 slider mapped
  logarithmically.
- The automation editor lists `engine.automationParams(channel)` as
  "Group - Parameter", and rebuilds the list when the channel changes.
- Drums keep volume and pan through the drum panel; effects are not exposed for
  them, since drum tracks are preview-only.

## Limits

- **Export does not include effects.** `AudioExporter` builds its own offline
  graph, so exported audio ignores the filter, every effect, the master chain,
  and all automation, and will differ from what you hear. Modules are written so
  this can be fixed: `create()` depends only on `env`, so the exporter can run it
  against an `OfflineAudioContext` and replay lanes through `targets()`. That is
  not implemented.
- Effects are not removed once created, and a first activation during playback
  can click.
- There is no latency compensation for the compressor and limiter.
- The filter is built in, not a module, and offers low-pass and high-pass only.
- Tempo automation is a per-step staircase, and its interaction with audio clips
  at a changing tempo depends on `AudioArrangement` (see below).
- Mix and automation changes are not in note undo, except automation lane edits.

## Manual testing

1. Distortion on a synth track: raise Mix and Drive and it crunches without a
   loudness jump; Tone darkens it. Mix 0 is bit-for-bit the dry sound.
2. Compressor on a drum-heavy track: raise the ratio and peaks flatten; Makeup
   restores level. Ratio 1 with Makeup 0 sounds unchanged.
3. Master limiter at about -6 dB with a hot mix: output stops exceeding the
   ceiling. Raise master volume and the ceiling still holds.
4. Draw a Distortion Mix lane on a track and a Master Volume fade-out; play, then
   Stop. Sliders take over again.
5. Delay and reverb still behave as before: delay repeats follow BPM changes,
   reverb is shared, muting a lane stops its tails.
6. Draw a Tempo lane (100 to 140 BPM) and play; try Undo and Redo, then clear it.
   Drawing while playing is refused with a status message. Put audio clips on a
   lane first and check they stay aligned.
7. Save, reload and confirm the master mix, every effect setting and all lanes
   return. Open an older project and confirm everything is at defaults.
8. Press New Sequence: master and lanes reset, in the UI and by ear.
9. Temporarily remove one effect's `<script>` tag. The app should load, that
   effect should be missing from the UI, and its saved keys should be ignored.