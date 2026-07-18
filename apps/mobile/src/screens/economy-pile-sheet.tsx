import { gameCrewTokens, type EconomyItemId } from '@gamecrew/core';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  itemClaimStatus,
  truncateWalletAddress,
  type ClaimStatusInput,
  type PileRow,
  type RarityPresentationTier,
} from './global-chat-logic';

const tokens = gameCrewTokens;

/** Border/glow color per rarity tier -- zero art budget, so rarity reads through a border color instead of custom art (UI review call). Common stays app-chrome gray; only the rarest tier gets a single accent color. */
const RARITY_BORDER_COLOR: Record<RarityPresentationTier, string> = {
  common: tokens.shell.divider,
  uncommon: '#5B8AC7',
  rare: '#B98CE0',
  legendary: '#E0B23C',
};

/** Rarer tiers carry slightly more visual weight on the claim affordance itself -- still calm, this is a trophy shelf not a slot machine. */
const RARITY_CLAIM_ACCENT: Record<RarityPresentationTier, string> = {
  common: tokens.shell.textMuted,
  uncommon: '#5B8AC7',
  rare: '#B98CE0',
  legendary: '#E0B23C',
};

/** Matches the frozen `useWallet()` contract's `WalletStatus` exactly (`'no_wallet' | 'ready' | 'offline'`) -- `'no_wallet'` is the expected state for every user until they first tap "Claim on-chain" (CLAIM-012) and is the state that makes the inline social-login step the entry point (UX spec section 6). */
export type WalletStatus = 'no_wallet' | 'ready' | 'offline';

/**
 * The pile/profile sheet: coolness up top, a wallet row, then every held
 * gift with its quantity and on-chain claim state, presented as a trophy
 * shelf (docs/prds/playful_economy.md, "Profile: The Flex Surface" / V1
 * Naming: this is the user's **Stash**). A modal reachable from the Global
 * Chat header, matching the one existing full-screen Modal precedent in
 * this app (game-view-debug-panel.tsx's player gallery launcher).
 *
 * Claim state (`claims`, `onClaimItem`) is accepted via props rather than
 * calling `useWallet()` directly, keeping this component presentational and
 * testable -- the parent screen wires the hook (see gamecrew-screens.tsx).
 * The Privy social-login step itself is also driven from the parent via
 * `onStartLogin`/`onCancelLogin` (UI-layer Privy hooks live in
 * gamecrew-screens.tsx, not here) so this component never imports
 * `@privy-io/expo` directly and stays easy to reason about in isolation.
 */
export function EconomyPileSheet({
  claims,
  coolness,
  onCancelLogin,
  onClaimItem,
  onClose,
  onStartLogin,
  pileRows,
  privyAvailable,
  visible,
  walletAddress,
  walletStatus,
}: {
  claims: readonly ClaimStatusInput[];
  coolness: number;
  /** Called when the user backs out of the inline social-login step (CLAIM-004). */
  onCancelLogin: () => void;
  onClaimItem: (itemId: EconomyItemId, quantity: number) => void;
  onClose: () => void;
  /** Called with the chosen provider when the user taps a social button. Resolves `true` once Privy succeeds (the row then falls through to the normal provisioning->minting flow as `walletStatus` updates) or `false` on cancel/error, so the row can escape a stuck "Setting up your wallet…" state and re-offer the login prompt (CLAIM-004). */
  onStartLogin: (provider: 'google' | 'apple') => Promise<boolean>;
  pileRows: readonly PileRow[];
  /** False when `EXPO_PUBLIC_PRIVY_APP_ID` is unset -- claim shows a graceful "unavailable" state instead of a login prompt that can never resolve. */
  privyAvailable: boolean;
  visible: boolean;
  walletAddress: string | null;
  walletStatus: WalletStatus;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.backdrop}>
        <Pressable accessibilityLabel="Close stash" accessibilityRole="button" onPress={onClose} style={styles.backdropTap} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <Text style={styles.headerTitle}>Your stash</Text>
            <Pressable accessibilityLabel="Close stash" accessibilityRole="button" onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>

          <View style={styles.coolnessCard}>
            <Text style={styles.coolnessLabel}>Coolness</Text>
            <Text style={styles.coolnessValue}>{coolness}</Text>
          </View>

          <WalletRow address={walletAddress} status={walletStatus} />

          {pileRows.length === 0 ? (
            <Text style={styles.emptyText}>Nothing in the stash yet -- claim your gift to get started.</Text>
          ) : (
            <ScrollView contentContainerStyle={styles.list}>
              {pileRows.map((row) => (
                <PileItemRow
                  claimStatus={itemClaimStatus(row.itemId, claims)}
                  key={row.itemId}
                  needsLogin={walletStatus === 'no_wallet'}
                  onCancelLogin={onCancelLogin}
                  onClaim={() => onClaimItem(row.itemId, row.quantity)}
                  onStartLogin={onStartLogin}
                  privyAvailable={privyAvailable}
                  row={row}
                />
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function WalletRow({ address, status }: { address: string | null; status: WalletStatus }) {
  if (status === 'offline') {
    return (
      <View style={styles.walletRow}>
        <Text style={styles.walletStatusMuted}>Wallet offline -- on-chain claims will retry later.</Text>
      </View>
    );
  }

  if (status === 'no_wallet' || !address) {
    // CLAIM-012: no wallet/login concept is surfaced here at all before the
    // user ever taps "Claim on-chain" -- this row simply doesn't render
    // anything in that case (the login step lives on the item row itself,
    // per spec section 6, not as a standing banner in the sheet header).
    return null;
  }

  return (
    <View style={styles.walletRow}>
      <View style={styles.walletDot} />
      <Text style={styles.walletAddress}>{truncateWalletAddress(address)}</Text>
      <Text style={styles.walletStatusReady}>Ready</Text>
    </View>
  );
}

function PileItemRow({
  claimStatus,
  needsLogin,
  onCancelLogin,
  onClaim,
  onStartLogin,
  privyAvailable,
  row,
}: {
  claimStatus: ReturnType<typeof itemClaimStatus>;
  needsLogin: boolean;
  onCancelLogin: () => void;
  onClaim: () => void;
  onStartLogin: (provider: 'google' | 'apple') => Promise<boolean>;
  privyAvailable: boolean;
  row: PileRow;
}) {
  const borderColor = RARITY_BORDER_COLOR[row.rarityTier];
  const accentColor = RARITY_CLAIM_ACCENT[row.rarityTier];
  return (
    <View style={[styles.itemRow, { borderColor }]}>
      <View style={styles.itemRowMain}>
        <Text style={styles.itemEmoji}>{row.emoji}</Text>
        <Text style={styles.itemLabel}>{row.label}</Text>
        <Text style={styles.itemQuantity}>{row.quantity}</Text>
        <ClaimAffordance
          accentColor={accentColor}
          needsLogin={needsLogin}
          onCancelLogin={onCancelLogin}
          onClaim={onClaim}
          onStartLogin={onStartLogin}
          privyAvailable={privyAvailable}
          status={claimStatus}
        />
      </View>
    </View>
  );
}

/**
 * Sequence per spec section 6: Unclaimed -> (first claim only) Login
 * required -> Provisioning -> Minting -> Minted -> Failed/retry. The login
 * step is an **inline expansion of this row**, never a second modal (the
 * PRD explicitly rules out a "wallet screen, lobby" on top of the pile).
 *
 * `needsLogin` (walletStatus === 'no_wallet') gates whether tapping "Claim
 * on-chain" expands into the two social buttons or goes straight through --
 * once a wallet address exists, every subsequent claim on any item skips
 * straight to minting, per spec ("after wallet exists, skip straight to
 * minting on subsequent claims").
 *
 * `expanded` is local, per-row UI state (not derived from `walletStatus`):
 * per the empty/loading/offline table's claim-flow row, if the login step
 * itself is cancelled, the row must collapse back to the plain "Claim
 * on-chain" button rather than staying expanded -- `walletStatus` alone
 * can't express that (it stays `'no_wallet'` either way), so this component
 * tracks its own expansion and resets it on cancel.
 */
function ClaimAffordance({
  accentColor,
  needsLogin,
  onCancelLogin,
  onClaim,
  onStartLogin,
  privyAvailable,
  status,
}: {
  accentColor: string;
  needsLogin: boolean;
  onCancelLogin: () => void;
  onClaim: () => void;
  onStartLogin: (provider: 'google' | 'apple') => Promise<boolean>;
  privyAvailable: boolean;
  status: ReturnType<typeof itemClaimStatus>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [provisioning, setProvisioning] = useState(false);

  // Once a wallet address lands (needsLogin flips false), any local
  // "provisioning" flag for this row is stale -- clear it so a *different*
  // item's claim doesn't stay stuck showing "Setting up your wallet…" after
  // the user already finished logging in from this or another row.
  useEffect(() => {
    if (!needsLogin) setProvisioning(false);
  }, [needsLogin]);

  if (status.kind === 'sending' || status.kind === 'pending') {
    return (
      <View accessibilityLabel="Minting on-chain" style={styles.claimPending}>
        <ActivityIndicator color={tokens.shell.textMuted} size="small" />
        <Text style={styles.claimPendingText}>minting…</Text>
      </View>
    );
  }

  if (status.kind === 'minted') {
    return (
      <View style={styles.claimMinted}>
        <Text style={[styles.claimMintedBadge, { color: accentColor }]}>{'✦'} on-chain</Text>
        {status.explorerUrl ? (
          <Pressable
            accessibilityLabel="View on Explorer"
            accessibilityRole="link"
            onPress={() => {
              void Linking.openURL(status.explorerUrl!);
            }}
            style={styles.claimExplorerLink}
          >
            <Text style={styles.claimExplorerLinkText}>View on Explorer</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (status.kind === 'failed') {
    return (
      <Pressable
        accessibilityLabel="Claim failed, tap to retry"
        accessibilityRole="button"
        onPress={onClaim}
        style={styles.claimRetry}
      >
        <Text style={styles.claimRetryText}>retry claim</Text>
      </Pressable>
    );
  }

  if (needsLogin && provisioning) {
    // Existing "Setting up your wallet…" treatment (spec: "already reads
    // calmly and says nothing about gas/chains" -- kept as is) for the brief
    // beat between a social button tap and the wallet address actually
    // landing in useWallet()'s snapshot.
    return (
      <View accessibilityLabel="Setting up your wallet" style={styles.claimPending}>
        <ActivityIndicator color={tokens.shell.textMuted} size="small" />
        <Text style={styles.claimPendingText}>Setting up your wallet…</Text>
      </View>
    );
  }

  if (needsLogin && expanded) {
    if (!privyAvailable) {
      // Graceful "unavailable" state when EXPO_PUBLIC_PRIVY_APP_ID is unset
      // -- everything else in the app stays unaffected, this row just can't
      // offer on-chain claiming right now.
      return (
        <View style={styles.claimUnavailable}>
          <Text style={styles.claimUnavailableText}>Claiming unavailable</Text>
        </View>
      );
    }
    return (
      <LoginPrompt
        onCancelLogin={() => {
          setExpanded(false);
          onCancelLogin();
        }}
        onStartLogin={async (provider) => {
          setProvisioning(true);
          const succeeded = await onStartLogin(provider);
          if (!succeeded) {
            // CLAIM-004: cancelled/failed login -- collapse back to the
            // plain "Claim on-chain" button (not stuck expanded on the
            // login prompt, not stuck on "Setting up your wallet…"),
            // silently retry-safe since the user can just tap again.
            setProvisioning(false);
            setExpanded(false);
            onCancelLogin();
          }
          // On success, `needsLogin` will flip false once the parent's
          // walletStatus updates, which the effect above uses to clear
          // `provisioning` -- no explicit action needed here.
          return succeeded;
        }}
      />
    );
  }

  return (
    <Pressable
      accessibilityLabel="Claim on-chain"
      accessibilityRole="button"
      onPress={() => {
        if (needsLogin) {
          setExpanded(true);
          return;
        }
        onClaim();
      }}
      style={[styles.claimButton, { borderColor: accentColor }]}
    >
      <Text style={[styles.claimButtonText, { color: accentColor }]}>Claim on-chain</Text>
    </Pressable>
  );
}

/**
 * Inline social-login expansion (spec section 6, step 2): "Sign in to
 * claim" eyebrow + two stacked social pills. No email/seed-phrase option
 * (social logins only, V1 scope) and no mention anywhere of wallet/Solana/
 * gas -- the user is signing in to claim a gift, not setting up a crypto
 * wallet.
 */
function LoginPrompt({
  onCancelLogin,
  onStartLogin,
}: {
  onCancelLogin: () => void;
  onStartLogin: (provider: 'google' | 'apple') => Promise<boolean>;
}) {
  return (
    <View style={styles.loginPrompt}>
      <Text style={styles.loginEyebrow}>Sign in to claim</Text>
      <Pressable
        accessibilityLabel="Continue with Google"
        accessibilityRole="button"
        onPress={() => onStartLogin('google')}
        style={styles.loginButton}
      >
        <Text style={styles.loginButtonText}>Continue with Google</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Continue with Apple"
        accessibilityRole="button"
        onPress={() => onStartLogin('apple')}
        style={styles.loginButton}
      >
        <Text style={styles.loginButtonText}>Continue with Apple</Text>
      </Pressable>
      <Pressable accessibilityLabel="Cancel sign in" accessibilityRole="button" onPress={onCancelLogin} style={styles.loginCancel}>
        <Text style={styles.loginCancelText}>Not now</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdropTap: StyleSheet.absoluteFill,
  sheet: {
    backgroundColor: tokens.shell.surface,
    borderTopLeftRadius: tokens.radii.lg,
    borderTopRightRadius: tokens.radii.lg,
    maxHeight: '78%',
    paddingBottom: tokens.spacing.xxl,
    paddingHorizontal: tokens.spacing.lg,
    paddingTop: tokens.spacing.sm,
  },
  handle: {
    alignSelf: 'center',
    backgroundColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    height: 4,
    marginBottom: tokens.spacing.md,
    width: 36,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: tokens.spacing.lg,
  },
  headerTitle: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.title,
    fontWeight: tokens.typography.weight.bold,
  },
  closeButton: {
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  closeButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  coolnessCard: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    marginBottom: tokens.spacing.md,
    paddingVertical: tokens.spacing.lg,
  },
  coolnessLabel: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  coolnessValue: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.display,
    fontWeight: tokens.typography.weight.bold,
    marginTop: tokens.spacing.xs,
  },
  walletRow: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.sm,
    flexDirection: 'row',
    gap: tokens.spacing.sm,
    marginBottom: tokens.spacing.lg,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.sm,
  },
  walletDot: {
    backgroundColor: '#4CD37B',
    borderRadius: tokens.radii.pill,
    height: 8,
    width: 8,
  },
  walletAddress: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.caption,
    fontVariant: ['tabular-nums'],
    fontWeight: tokens.typography.weight.medium,
  },
  walletStatusReady: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
  },
  walletStatusMuted: {
    color: tokens.shell.textDim,
    flex: 1,
    fontSize: tokens.typography.size.caption,
  },
  emptyText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.body,
    paddingVertical: tokens.spacing.xl,
    textAlign: 'center',
  },
  list: {
    gap: tokens.spacing.sm,
    paddingBottom: tokens.spacing.lg,
  },
  itemRow: {
    backgroundColor: tokens.shell.surfaceRaised,
    borderRadius: tokens.radii.md,
    borderWidth: 1.5,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.md,
  },
  itemRowMain: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: tokens.spacing.md,
  },
  itemEmoji: {
    fontSize: 26,
  },
  itemLabel: {
    color: tokens.shell.text,
    flex: 1,
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.medium,
  },
  itemQuantity: {
    color: tokens.shell.text,
    fontVariant: ['tabular-nums'],
    fontSize: tokens.typography.size.body,
    fontWeight: tokens.typography.weight.bold,
  },
  claimButton: {
    borderRadius: tokens.radii.pill,
    borderWidth: 1,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.xs,
  },
  claimButtonText: {
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.medium,
  },
  claimPending: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: tokens.spacing.xs,
  },
  claimPendingText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
  },
  claimMinted: {
    alignItems: 'flex-end',
    gap: 2,
  },
  claimMintedBadge: {
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
  },
  claimExplorerLink: {
    paddingVertical: 2,
  },
  claimExplorerLinkText: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    textDecorationLine: 'underline',
  },
  claimRetry: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  claimRetryText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    textDecorationLine: 'underline',
  },
  claimUnavailable: {
    paddingHorizontal: tokens.spacing.sm,
    paddingVertical: tokens.spacing.xs,
  },
  claimUnavailableText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
  },
  loginPrompt: {
    gap: tokens.spacing.xs,
    marginTop: tokens.spacing.sm,
    width: '100%',
  },
  loginEyebrow: {
    color: tokens.shell.textMuted,
    fontSize: tokens.typography.size.caption,
    fontWeight: tokens.typography.weight.bold,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  loginButton: {
    alignItems: 'center',
    backgroundColor: tokens.shell.surfaceRaised,
    borderColor: tokens.shell.divider,
    borderRadius: tokens.radii.pill,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 40,
    paddingHorizontal: tokens.spacing.lg,
  },
  loginButtonText: {
    color: tokens.shell.text,
    fontSize: tokens.typography.size.label,
    fontWeight: tokens.typography.weight.medium,
  },
  loginCancel: {
    alignItems: 'center',
    paddingVertical: tokens.spacing.xs,
  },
  loginCancelText: {
    color: tokens.shell.textDim,
    fontSize: tokens.typography.size.caption,
    textDecorationLine: 'underline',
  },
});
