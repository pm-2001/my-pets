# Changelog

All notable changes to meowverlay are recorded here. Versions follow
[semantic versioning](https://semver.org/).

## 0.2.0 — 2026-08-01

A visual overhaul of the cat, plus friendlier sizing and a proper litter of
distinctly-coloured pets.

### Animation & artwork
- **Redrawn body.** The old ellipse is replaced by a smooth, non-elliptical
  side profile (chest, arched back, rounded rump), with the lighter belly patch
  clipped to the body so it can never spill past the outline.
- **Real cat walk.** Legs now step in a true four-beat *lateral-sequence* gait
  (near-hind → near-front → far-hind → far-front) instead of the old two-beat
  diagonal bounce, so walking reads as a smooth wave rather than random.
- **Jointed legs.** Each leg bends at a real knee — the upper leg stays put and
  the shin folds back under the body when the cat sits or sleeps, keeping the
  legs parallel instead of crossing or shrinking.
- **Depth.** The far pair of legs is drawn a shade darker behind the body, and
  the near pair in front, giving the side view a sense of depth.
- **Face.** Nose and mouth centred below the eyes and whiskers shortened for a
  tidier expression.
- **Sleep fixes.** The tail stays attached to the rump when the body lowers, and
  the sleeping body no longer looks deflated.

### Behaviour & settings
- **Distinct coats for a litter.** When you run several cats, each is now
  guaranteed a different coat colour (up to the seven available) — new pets
  re-roll their seed until their colour differs from every sibling.
- **Bigger size presets.** Small / Normal / Large are now 1.0× / 1.5× / 2.3×
  (previously 0.7× / 1.0× / 1.5×), and the default is the new Normal — the old
  "Large" only looked medium.

### Docs
- Refreshed the README preview images (awake and asleep) to the new artwork.
