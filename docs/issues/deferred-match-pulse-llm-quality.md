# Deferred: improve Match Pulse LLM commentary quality

## Status

Deferred until after the hackathon demo. Match Pulse is functionally working, and the current grounded commentary plus deterministic fallbacks are sufficient for the demo.

## Problem

The LLM commentary still needs editorial improvement. Some accepted lines can feel repetitive, overextended, too similar to event summaries, or less natural than a live football commentator.

This should not be solved through quick prompt edits. We should first agree on the desired commentary voice, examine representative saved outputs, and define how quality will be evaluated without weakening truth validation.

## Research and brainstorming

Before implementation:

1. Collect representative good and weak lines across routine, pressure, goal, card, substitution, restart, and final-whistle beats.
2. Define the desired commentator voice, pacing, vocabulary, sentence length, and variation.
3. Separate prompt problems from model limitations, semantic-frame limitations, and validator rejections.
4. Decide whether different beat types need distinct prompt strategies or examples.
5. Evaluate whether reflection should focus more explicitly on naturalness, repetition, and continuity.
6. Design a small, fixed evaluation corpus so prompt experiments do not repeatedly process full fixtures.
7. Compare candidates using human review first, with an optional LLM judge only as supporting evidence.

## Guardrails

- TxLINE and the canonical match state remain the only sources of match truth.
- Quality improvements must not weaken validation of teams, players, score, clock, actions, locations, or match lifecycle.
- Invalid output must continue to use deterministic commentary.
- Experiments should use a small isolated sample before rematerializing any fixture.
- Existing completed fixtures should not be regenerated until a new prompt/model version is intentionally approved.

## Acceptance criteria

- A documented commentary style and voice is agreed upon.
- A small representative evaluation dataset is selected.
- Quality dimensions and review scoring are defined.
- Prompt/reflection alternatives are compared on the same examples.
- Truth validation and fallback behavior remain unchanged or become stricter.
- The chosen version is approved before any historical batch is regenerated.

## Not part of the current phase

- Prompt rewriting or model changes.
- Regenerating Mexico–Ecuador or France–Morocco.
- Generating commentary for additional historical fixtures.
- Changing live-fixture automation.
