export interface User {
  id: string;
  username: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  created_at?: string;
  is_approved?: boolean;
  is_owner?: boolean;
  is_banned?: boolean;
  self_destruct_months?: number;
  last_seen_at?: string;
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group' | 'channel' | 'saved';
  title?: string;
  username?: string;
  description?: string;
  avatar_url?: string;
  pinned_message_id?: string;
  security_mode?: 'normal' | 'e2ee_initializing' | 'e2ee_active' | 'e2ee_failed';
  unread_count?: number;
  disappearing_ttl?: number;
  slow_mode_seconds?: number;
  is_forum?: boolean;
  created_at: string;
  updated_at: string;
  participants?: User[];
  last_message?: Message;
}

export interface ConversationMemberDetail {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  role: string;
  joined_at: string;
}

export interface ConversationInvite {
  id: string;
  conversation_id: string;
  creator_id: string;
  invite_code: string;
  max_uses: number;
  uses_count: number;
  expires_at?: string;
  is_revoked: boolean;
  created_at: string;
}

export interface UserPresence {
  user_id: string;
  is_online: boolean;
  last_seen_at?: string;
}

export interface MessageReader {
  id?: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  read_at: string;
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Attachment {
  id: string;
  conversation_id: string;
  uploader_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  is_encrypted: boolean;
  is_view_once?: boolean;
  storage_type?: string;
  public_url?: string;
  created_at: string;
  // Local decrypted file metadata
  localUrl?: string;
  encryptedKeyBase64?: string;
  ivBase64?: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  sender_username?: string;
  topic_id?: string;
  ciphertext: string;
  nonce: string;
  ephemeral_public_key?: string;
  idempotency_key?: string;
  reply_to_id?: string;
  edited_at?: string;
  is_deleted?: boolean;
  is_pinned?: boolean;
  poll_id?: string;
  poll_key?: string;
  poll_iv?: string;
  is_forwarded?: boolean;
  forward_from_name?: string;
  reactions?: Record<string, string[]>;
  is_read?: boolean;
  read_count?: number;
  views_count?: number;
  expires_at?: string;
  created_at: string;
  // Local decrypted state
  plaintext?: string;
  decryptionError?: boolean;
  status?: 'sending' | 'accepted' | 'delivered' | 'read';
  // Rich payload metadata if present (attachments, voice note, round video, stickers)
  attachmentMeta?: {
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    keyBase64: string;
    ivBase64: string;
    isVoice?: boolean;
    isRoundVideo?: boolean;
    isPhoto?: boolean;
    isVideo?: boolean;
    isSticker?: boolean;
    isViewOnce?: boolean;
    viewOnceBurned?: boolean;
    storageType?: string;
    publicUrl?: string;
    stickerPackId?: string;
    stickerId?: string;
    stickerUrl?: string;
    caption?: string;
    duration?: number;
    width?: number;
    height?: number;
    blurredPreviewBase64?: string;
  };
  callEvent?: {
    call_id: string;
    call_type: 'audio' | 'video';
    outcome: 'completed' | 'missed' | 'declined' | 'rejected' | 'cancelled';
    duration_seconds: number;
    caller_id?: string;
    caller_name?: string;
    receiver_id?: string;
  };
  whisper?: {
    target_username: string;
    target_id?: string;
    secret_text: string;
    sender_username?: string;
    sender_id?: string;
  };
  watchPartyInvite?: {
    session_id: string;
    media_title: string;
    media_url: string;
    leader_name: string;
  };
  bot_actions?: BotActionButton[][];
}

export interface BotActionButton {
  text: string;
  command?: string;
  action?: string;
  conversation_id?: string;
  user_id?: string;
  token?: string;
}

export interface AuthSession {
  user: User;
  token?: string;
  device_id?: string;
  status?: string;
  message?: string;
}

export interface ServerStats {
  users_count: number;
  approved_users_count: number;
  pending_users_count: number;
  banned_users_count: number;
  conversations_count: number;
  messages_count: number;
  active_sessions_count: number;
  active_ws_connections: number;
  server_uptime_seconds: number;
  goroutines_count: number;
  memory_alloc_mb: number;
  memory_sys_mb: number;
  db_dialect: string;
}

export interface Device {
  id: string;
  user_id: string;
  device_name: string;
  is_active: boolean;
  last_seen_at: string;
  created_at: string;
}

export interface DeviceKeyBundle {
  device_id: string;
  identity_public_key: string;
  registration_id?: number;
  signed_pre_key?: string;
  one_time_pre_key?: string;
}

export interface UserKeyPackage {
  user_id: string;
  devices: DeviceKeyBundle[];
}

export interface Sticker {
  id: string;
  pack_id: string;
  emoji: string;
  asset_url: string;
  width: number;
  height: number;
}

export interface StickerPack {
  id: string;
  name: string;
  title: string;
  thumbnail_url: string;
  author: string;
  creator_id?: string;
  share_code?: string;
  sticker_count: number;
  is_builtin: boolean;
  stickers?: Sticker[];
}

export interface CallLog {
  id: string;
  conversation_id: string;
  caller_id: string;
  caller_name?: string;
  receiver_id: string;
  receiver_name?: string;
  call_type: 'audio' | 'video';
  status: 'completed' | 'missed' | 'rejected' | 'failed';
  duration_seconds: number;
  created_at: string;
  ended_at?: string;
}

export interface CallSignal {
  call_id: string;
  conversation_id: string;
  caller_id: string;
  receiver_id: string;
  call_type: 'audio' | 'video';
  signal_type: 'invite' | 'ringing' | 'accept' | 'reject' | 'hangup' | 'cancel' | 'sdp_offer' | 'sdp_answer' | 'ice_candidate' | 'screen_share_start' | 'screen_share_stop' | 'screen_quality_change' | 'screen_quality_request';
  data?: any;
}

export interface VoiceChatRoom {
  id: string;
  conversation_id: string;
  title: string;
  is_active: boolean;
  created_by: string;
  participant_count: number;
  created_at: string;
  ended_at?: string;
}

export interface VoiceChatParticipant {
  room_id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url?: string;
  is_muted: boolean;
  is_speaking: boolean;
  joined_at: string;
}

export interface GIFItem {
  id: string;
  title: string;
  url: string;
  preview_url: string;
  width: number;
  height: number;
}

export interface PollOption {
  id: number;
  poll_id: string;
  text: string;
  vote_count: number;
}

export interface Poll {
  id: string;
  conversation_id: string;
  creator_id: string;
  question: string;
  is_anonymous: boolean;
  allows_multiple: boolean;
  is_quiz: boolean;
  correct_option?: number;
  explanation?: string;
  is_closed: boolean;
  created_at: string;
  options?: PollOption[];
  total_votes: number;
  my_votes?: number[];
}

export interface Story {
  id: string;
  user_id: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  media_url: string;
  media_type: 'photo' | 'video';
  caption?: string;
  created_at: string;
  expires_at: string;
}

export interface ScheduledMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  nonce: string;
  scheduled_for: string;
  is_sent: boolean;
  is_silent?: boolean;
  created_at: string;
}

export interface ForumTopic {
  id: string;
  conversation_id: string;
  title: string;
  icon: string;
  color: string;
  created_at: string;
  message_count?: number;
}

export interface ConversationPin {
  id: string;
  conversation_id: string;
  message_id: string;
  pinned_by: string;
  pinned_at: string;
  message?: Message;
}

export interface StorageStatus {
  active_engine: string;
  arvan_s3_online: boolean;
  arvan_endpoint: string;
  bucket: string;
  region: string;
  local_dir: string;
  s3_uploads: number;
  local_uploads: number;
  failover_count: number;
  last_probe_at: string;
  last_error?: string;
  ping_latency_ms?: number;
}

export interface MediaShare {
  id: string;
  message_id?: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  creator_id: string;
  creator_name?: string;
  has_password: boolean;
  expires_at?: string;
  max_downloads: number;
  download_count: number;
  views_count: number;
  created_at: string;
  share_url: string;
  stream_url: string;
  watch_url: string;
}

export interface WatchPartySession {
  conversation_id: string;
  media_url: string;
  media_title: string;
  leader_id: string;
  leader_name: string;
  state: 'playing' | 'paused' | 'buffering';
  current_time: number;
  playback_rate: number;
  last_synced_at: string;
}

