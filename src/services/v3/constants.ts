/**
 * airthread/3 protocol constants.
 *
 * Every domain separator, KDF info string, Nostr tag, limit, timeout and
 * retention value lives here. Nothing outside this file may hard-code a
 * protocol constant -- see the implementation plan, [X-01].
 */

// ============================================================================
// PROTOCOL IDENTIFIERS  [V-01]
// ============================================================================

export const PROTOCOL = 'airthread/3' as const;
export const EXT_TRANSPORT = 'airthread/3-nostr-transport' as const;
export const EXT_PUBLIC_ROOMS = 'airthread/3-public-rooms' as const;
export const EXT_PRESENCE = 'airthread/3-presence' as const;
export const TRYSTERO_APP_ID = 'airthread-protocol-v3';
export const PROTOCOL_VERSION_TAG = '3';

// ============================================================================
// NOSTR  [T-02] [T-03]
// ============================================================================

/** NIP-33 parameterized replaceable event kind. Configurable by design. */
export const NOSTR_KIND = 30078;

export const TAG_D = 'd';
export const TAG_T = 't';
export const TAG_R = 'r';
export const TAG_MODE = 'm';
export const TAG_VERSION = 'v';
export const TAG_EXPIRATION = 'expiration';

export const T_ROOM_PACKET = 'aircomic-room-packet';
export const T_PUBLIC_ROOM = 'aircomic-public-room';
export const T_PUBLIC_PRESENCE = 'aircomic-public-presence';
export const T_USER_PRESENCE = 'aircomic-user-presence';
export const T_INBOX = 'aircomic-inbox';

/** Stable `d` tag prefixes for the packets that must be findable in one query. */
export const D_GENESIS_PREFIX = 'genesis:';
export const D_METADATA_PREFIX = 'meta:';
export const D_PUBLIC_PRESENCE_PREFIX = 'presence:';
/** One tag per room: every occupant's announcement replaces only their own. */
export const D_ROOM_PRESENCE_PREFIX = 'roster:';

// ============================================================================
// PUBLISH POLICY  [T-07]
// ============================================================================

export const PUBLISH_TARGET_RELAYS = 5;
export const PUBLISH_QUORUM = 2;
export const PUBLISH_TIMEOUT_MS = 5000;
export const PUBLISH_MAX_ATTEMPTS = 8;
export const PUBLISH_BACKOFF_BASE_MS = 2000;
export const PUBLISH_BACKOFF_CAP_MS = 300000;
export const PUBLISH_BACKOFF_JITTER = 0.25;

// ============================================================================
// RETENTION  [T-09] as amended by [L-06]
// ============================================================================

/** Chat expiration. Control packets deliberately carry no expiration [L-05]. */
export const CHAT_RETENTION_SEC = 30 * 24 * 3600;
export const PUBLIC_ROOM_PRESENCE_SEC = 120;
export const ROOM_PRESENCE_SEC = 180;
export const USER_PRESENCE_SEC = 900;
export const QUICK_MESSAGE_SEC = 3600;
export const INVITE_SEC = 7 * 24 * 3600;
export const PUBLIC_DESCRIPTOR_SEC = 24 * 3600;

// ============================================================================
// CADENCES
// ============================================================================

export const PUBLIC_PRESENCE_REFRESH_MS = 45000;
export const USER_PRESENCE_REFRESH_MS = 120000;
export const USER_PRESENCE_FRESH_MS = 330000;
export const USER_PRESENCE_SWEEP_MS = 30000;
export const ROOM_PRESENCE_REFRESH_MS = 60000;
export const ROOM_PRESENCE_FRESH_MS = 200000;
export const ROOM_PRESENCE_SWEEP_MS = 30000;
/** Enough occupants for one query to answer "who is in this room" [PU-06]. */
export const ROOM_PRESENCE_QUERY_LIMIT = 200;
export const DIRECTORY_REFRESH_MS = 600000;
export const PUBLIC_DESCRIPTOR_REFRESH_MS = 600000;

export const RELAY_RECONNECT_BASE_MS = 4000;
export const RELAY_RECONNECT_MAX_MS = 60000;

/** Overlap subtracted from a stored cursor when resubscribing [T-08]. */
export const SUBSCRIPTION_OVERLAP_MS = 60000;

// ============================================================================
// STRUCTURAL BOUNDS  [P-04] [L-17]
// ============================================================================

export const MAX_NOSTR_EVENT_BYTES = 65536;
export const MAX_ENVELOPE_BYTES = 61440;
export const MAX_CHAT_TEXT_BYTES = 8192;
export const MAX_JSON_DEPTH = 16;
export const MAX_OBJECT_KEYS = 128;
export const MAX_ARRAY_ELEMENTS = 256;

/**
 * Structural ceiling on private membership, NOT a policy cap [L-17].
 *
 * A RekeyPacket carries one RSA-OAEP-2048 slot per member: 256 bytes becomes
 * 344 base64url characters, plus a 43-character participantId key, JSON
 * punctuation, and the same id again in the members array -- about 440 bytes
 * per member. Against MAX_ENVELOPE_BYTES that permits roughly 137, so 128 is
 * the bound the validator enforces. Rooms are not otherwise limited.
 */
export const MAX_PRIVATE_MEMBERS_HARD = 128;

/** Above this, WebRTC acceleration is not attempted; the room uses Nostr [L-17]. */
export const WEBRTC_MEMBER_THRESHOLD = 20;

/** Global cap on simultaneous WebRTC peer connections [W-01]. */
export const MAX_WEBRTC_PEERS = 20;

export const MAX_SCREEN_NAME_BYTES = 64;
export const MAX_ROOM_TITLE_BYTES = 80;
export const MAX_ROOM_DESCRIPTION_BYTES = 500;
export const MAX_TAGS_PER_ROOM = 10;
export const MAX_TAG_BYTES = 32;
export const MAX_RECOVERY_IDS = 64;

// ============================================================================
// TIMESTAMP ACCEPTANCE  [D-04]
// ============================================================================

export const LIVE_FUTURE_SKEW_MS = 300000;
export const LIVE_PAST_WINDOW_MS = 3600000;

// ============================================================================
// MEMBERSHIP / ROTATION  [PR-07]
// ============================================================================

export const OLD_ROUTE_MONITOR_MS = 30 * 24 * 3600 * 1000;
export const ROOT_KEY_ID = 'root-v3';
export const PUBLIC_KEY_ID = 'public-v3';

/** Join request retry cadence [PR-03]. */
export const JOIN_REQUEST_RETRY_MS = 15000;
export const JOIN_REQUEST_MAX_ATTEMPTS = 20;

// ============================================================================
// DEDUP RETENTION  [D-02] [X-06]
// ============================================================================

export const DEDUP_CHAT_RETENTION_MS = (CHAT_RETENTION_SEC + 7 * 24 * 3600) * 1000;
export const DEDUP_MEMORY_LRU_SIZE = 4000;

// ============================================================================
// KDF SALT PREFIXES AND INFO STRINGS  [X-02]
// ============================================================================

export const SALT_ROOT = 'airthread-v3-root:';
export const SALT_ROUTING = 'airthread-v3-routing:';
export const SALT_WEBRTC = 'airthread-v3-webrtc:';

export const INFO_ROOT = 'airthread-private-root-key-v3';
export const INFO_ROUTING = 'airthread-private-routing-v3';
export const INFO_WEBRTC_ROOM = 'airthread-private-webrtc-room-v3';
export const INFO_WEBRTC_PASSWORD = 'airthread-private-webrtc-password-v3';

export const PREFIX_ROOM_TAG = 'airthread-v3-room:';
export const PREFIX_PUBLIC_ROOM_ID = 'airthread-public-room-v3:';
export const PREFIX_INBOX_TAG = 'airthread-inbox-v3:';
export const PREFIX_PRESENCE_CAP_TAG = 'airthread-presence-cap-v3:';
export const PREFIX_NOSTR_ROOM_KEY = 'airthread-nostr-room-v3:';
export const PREFIX_NOSTR_INBOX_SCOPE = 'inbox:';

export const SUFFIX_RESPONSE_TAG = '~r';
export const SUFFIX_QUICKMSG_TAG = '~qm';

/** AAD prefix for the hybrid sealed envelope [X-10]. */
export const SEAL_AAD_PREFIX = 'airthread/3-presence:';

// ============================================================================
// SIGNATURE DOMAIN TAGS  [X-01]
// ============================================================================

export const DOMAIN_ROOM_ENVELOPE = 'AIRTHREAD_ROOM_ENVELOPE_V3:';
export const DOMAIN_PRIVATE_MESSAGE = 'AIRTHREAD_PRIVATE_MESSAGE_V3:';
export const DOMAIN_PUBLIC_MESSAGE = 'AIRTHREAD_PUBLIC_MESSAGE_V3:';
export const DOMAIN_GENESIS = 'AIRTHREAD_GENESIS_V3:';
export const DOMAIN_REKEY = 'AIRTHREAD_REKEY_V3:';
export const DOMAIN_CAPABILITY_ROTATION = 'AIRTHREAD_CAPABILITY_ROTATION_V3:';
export const DOMAIN_JOIN_REQUEST = 'AIRTHREAD_JOIN_REQUEST_V3:';
export const DOMAIN_JOIN_DECISION = 'AIRTHREAD_JOIN_DECISION_V3:';
export const DOMAIN_METADATA = 'AIRTHREAD_METADATA_V3:';
export const DOMAIN_HELLO = 'AIRTHREAD_HELLO_V3:';
export const DOMAIN_SEALED_ENVELOPE = 'AIRTHREAD_SEALED_ENVELOPE_V3:';
export const DOMAIN_QUICK_MESSAGE = 'AIRTHREAD_QUICK_MESSAGE_V3:';
export const DOMAIN_ROOM_INVITE = 'AIRTHREAD_ROOM_INVITE_V3:';
export const DOMAIN_INVITE_RESPONSE = 'AIRTHREAD_INVITE_RESPONSE_V3:';
export const DOMAIN_PRESENCE = 'AIRTHREAD_PRESENCE_V3:';
export const DOMAIN_CONTACT_CAPABILITY = 'AIRTHREAD_CONTACT_CAPABILITY_V3:';
export const DOMAIN_PUBLIC_ROOM_DESCRIPTOR = 'AIRTHREAD_PUBLIC_ROOM_DESCRIPTOR_V3:';
export const DOMAIN_PUBLIC_ROOM_TOMBSTONE = 'AIRTHREAD_PUBLIC_ROOM_TOMBSTONE_V3:';
export const DOMAIN_PUBLIC_ROOM_METADATA = 'AIRTHREAD_PUBLIC_ROOM_METADATA_V3:';
export const DOMAIN_ROOM_PRESENCE = 'AIRTHREAD_ROOM_PRESENCE_V3:';
export const DOMAIN_RECOVERY_REQUEST = 'AIRTHREAD_RECOVERY_REQUEST_V3:';

// ============================================================================
// ENVELOPE AAD  [P-02]
// ============================================================================

export const ENVELOPE_AAD_PREFIX = 'airthread/3:';

// ============================================================================
// OCCUPANCY BUCKETS  [PU-04] [X-12]
// ============================================================================

export const OCCUPANCY_BUCKETS: ReadonlyArray<{ min: number; label: string }> = [
  { min: 500, label: '500+' },
  { min: 100, label: '100-499' },
  { min: 25, label: '25-99' },
  { min: 10, label: '10-24' },
  { min: 5, label: '5-9' },
  { min: 1, label: '1-4' },
  { min: 0, label: '0' },
];
