import { gameCrewTokens } from '@gamecrew/core';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  buildGameViewScorerRows,
  type GameViewScorerRow,
  type GameViewScorerTimelineEntry,
} from './game-view-checkpoint-logic';

const tokens = gameCrewTokens;

export interface GameViewFullTimeTeam {
  name: string;
  color: string;
  participant: 1 | 2;
}

/**
 * Item 12's full-time board: the landing view for a completed match in Game
 * View -- a scorer timeline (derived off-component by
 * `buildGameViewScorerTimeline`), and the two entry points into playback
 * ("Play highlights" / "Watch full match"). Styled after the existing
 * takeover visual language (black shell, bold typography-led layout, team
 * color used only as a sparing accent -- see takeover-shared.tsx's header
 * comment) rather than introducing a new visual system, since this is
 * another full-screen broadcast moment like a goal takeover, just a
 * resting one instead of a momentary one.
 *
 * Round 5/item 6 layout fix: the match header directly above this board
 * (gamecrew-screens.tsx's `DetailTeamScore`/`DetailMatchClock`) already
 * shows the score, so this board no longer duplicates it -- just a slim
 * "FULL TIME" caption. The scorer list reads as a classic broadcast FT
 * graphic instead: home team's scorers left-aligned in a left column, away
 * team's right-aligned in a right column, with a small centered ball glyph
 * between them (see `ScorerColumns`).
 *
 * Rendered by `GameViewScreen` as a sibling overlay over the idle board
 * (same absolute-fill pattern `GameViewStaleBanner` uses) when the match is
 * completed and nothing is actively playing; hidden while a clip, the full
 * replay, or highlights are running, and shown again once playback settles
 * back to the end state.
 */
export function GameViewFullTimeBoard({
  awayTeam,
  homeTeam,
  onPlayHighlights,
  onWatchFullMatch,
  recap,
  score,
  scorerTimeline,
}: {
  awayTeam: GameViewFullTimeTeam;
  homeTeam: GameViewFullTimeTeam;
  onPlayHighlights: () => void;
  onWatchFullMatch: () => void;
  /** Item 14: the match recap row, rendered by the caller (gamecrew-screens.tsx) below the scorer timeline. Optional/undefined renders nothing extra -- this board has no opinion on recap content itself. */
  recap?: ReactNode;
  score: { home: number; away: number };
  scorerTimeline: readonly GameViewScorerTimelineEntry[];
}) {
  return (
    <View
      accessibilityLabel={`Full time. ${homeTeam.name} ${score.home}, ${awayTeam.name} ${score.away}.`}
      accessibilityLiveRegion="polite"
      accessible
      style={styles.root}
    >
      <Text style={styles.eyebrow}>Full time</Text>

      {scorerTimeline.length > 0 ? (
        <ScorerColumns awayTeam={awayTeam} homeTeam={homeTeam} scorerTimeline={scorerTimeline} />
      ) : null}

      {recap}

      <View style={styles.actions}>
        <Pressable
          accessibilityLabel="Play highlights"
          accessibilityRole="button"
          onPress={onPlayHighlights}
          style={({ pressed }) => [styles.primaryAction, pressed && styles.actionPressed]}
        >
          <Text style={styles.primaryActionText}>Play highlights</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="Watch full match"
          accessibilityRole="button"
          onPress={onWatchFullMatch}
          style={({ pressed }) => [styles.secondaryAction, pressed && styles.actionPressed]}
        >
          <Text style={styles.secondaryActionText}>Watch full match</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Broadcast-style two-column scorer graphic (item 6b): the home team's
 * goals left-aligned on the left, the away team's right-aligned on the
 * right, a small centered ball glyph between the columns -- the classic TV
 * full-time card layout. Each column preserves match order top to bottom.
 * A team with no goals simply renders an empty column (no placeholder row),
 * so a 3-0 scoreline shows three rows on one side and nothing on the other.
 */
function ScorerColumns({
  awayTeam,
  homeTeam,
  scorerTimeline,
}: {
  awayTeam: GameViewFullTimeTeam;
  homeTeam: GameViewFullTimeTeam;
  scorerTimeline: readonly GameViewScorerTimelineEntry[];
}) {
  // Item 13b: nameless goals for a team collapse into one clustered row
  // ("⚽ 3′ · 18′ · 37′") instead of a repeated bare "Goal {minute}′" line
  // per goal -- see buildGameViewScorerRows's doc comment.
  const rows = buildGameViewScorerRows(scorerTimeline);
  const homeRows = rows.filter((row) => row.participant === homeTeam.participant);
  const awayRows = rows.filter((row) => row.participant !== homeTeam.participant);

  return (
    <View style={styles.scorerColumns}>
      <View style={styles.scorerColumn}>
        {homeRows.map((row) => (
          <ScorerRow align="left" key={row.checkpointId} row={row} />
        ))}
      </View>

      <Text style={styles.ballGlyph}>⚽</Text>

      <View style={styles.scorerColumn}>
        {awayRows.map((row) => (
          <ScorerRow align="right" key={row.checkpointId} row={row} />
        ))}
      </View>
    </View>
  );
}

/**
 * Item 13a: name and minute render as two separate Text nodes inside a flex
 * row, rather than one combined string sharing a single `numberOfLines={1}`
 * truncation -- a single string cut "Anthony Gordon 55′" into "Anthony
 * Gordon 5…" because RN truncates from wherever the line overflows, with no
 * way to protect the tail. The minute now sits in its own
 * `flexShrink: 0` node (never truncates, never wraps) while the name node
 * takes `flexShrink: 1` and ellipsizes on its own if space is genuinely
 * short -- exactly the spec's "minute never truncates; ellipsize the NAME
 * if space is truly short."
 */
function ScorerRow({
  align,
  row,
}: {
  align: 'left' | 'right';
  row: GameViewScorerRow;
}) {
  const isRight = align === 'right';

  if (row.kind === 'cluster') {
    const minutesLabel = row.minutes.map((minute) => formatScorerRowMinuteLabel(minute)).join(' · ');
    return (
      <View style={[styles.scorerRow, isRight && styles.scorerRowReverse]}>
        <Text style={styles.scorerText}>⚽</Text>
        <Text numberOfLines={1} style={[styles.scorerText, styles.scorerMinute]}>
          {minutesLabel}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.scorerRow, isRight && styles.scorerRowReverse]}>
      <Text
        numberOfLines={1}
        style={[styles.scorerText, styles.scorerName, isRight ? styles.textRight : styles.textLeft]}
      >
        {row.scorerName}
      </Text>
      <Text style={[styles.scorerText, styles.scorerMinute]}>
        {formatScorerRowMinuteLabel(row.minute)}
      </Text>
    </View>
  );
}

/** Mirrors game-view-checkpoint-logic.ts's private `formatCheckpointMinuteLabel` (90+2′ for second-half stoppage) -- kept local since that helper isn't exported, and this is pure presentation formatting over an already-derived `minute`. */
function formatScorerRowMinuteLabel(minute: number): string {
  return minute > 90 ? `90+${minute - 90}′` : `${minute}′`;
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'stretch',
    backgroundColor: tokens.shell.background,
    justifyContent: 'center',
    paddingHorizontal: tokens.spacing.xl,
    paddingVertical: tokens.spacing.xxl,
    zIndex: 15,
  },
  eyebrow: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 2,
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  textLeft: {
    textAlign: 'left',
  },
  textRight: {
    textAlign: 'right',
  },
  scorerColumns: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: tokens.spacing.md,
    justifyContent: 'center',
    marginTop: tokens.spacing.xl,
  },
  scorerColumn: {
    flex: 1,
    gap: tokens.spacing.xs,
  },
  ballGlyph: {
    fontSize: tokens.typography.size.body,
    marginTop: 2,
  },
  scorerText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
  /** Item 13a: name + minute as siblings in a flex row, not one truncated string -- see ScorerRow's doc comment. */
  scorerRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 4,
  },
  scorerRowReverse: {
    flexDirection: 'row-reverse',
  },
  scorerName: {
    flexShrink: 1,
  },
  /** Never shrinks/truncates/wraps -- the minute is always fully visible. */
  scorerMinute: {
    flexShrink: 0,
  },
  actions: {
    gap: tokens.spacing.sm,
    marginTop: tokens.spacing.xxl,
  },
  primaryAction: {
    alignItems: 'center',
    backgroundColor: tokens.shell.text,
    borderRadius: tokens.radii.pill,
    paddingVertical: tokens.spacing.md,
  },
  primaryActionText: {
    color: tokens.shell.inverseText,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  secondaryAction: {
    alignItems: 'center',
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: tokens.spacing.md,
  },
  secondaryActionText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
  actionPressed: {
    opacity: 0.72,
  },
});
