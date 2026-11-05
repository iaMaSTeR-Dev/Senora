import { Attachment, AuthSession, CallLog, Conversation, ConversationInvite, ConversationMemberDetail, Device, GIFItem, IceServerConfig, Message, MessageReader, Poll, ScheduledMessage, StickerPack, Story, User, UserKeyPackage, UserPresence, VoiceChatParticipant, VoiceChatRoom } from '../app/types';
import { migrateBrowserStorage } from './storageMigration';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('senora_token', token);
    } else {
      localStorage.removeItem('senora_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      migrateBrowserStorage();
      this.token = localStorage.getItem('senora_token');
    }
    return this.token;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const token = this.getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(endpoint, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let errorMsg = `HTTP Error ${res.status}`;
      try {
        const errJson = await res.json();
        if (errJson?.error?.message) {
          errorMsg = errJson.error.message;
        }
      } catch {
        // Fallback to text
      }
      throw new Error(errorMsg);
    }

    return res.json() as Promise<T>;
  }

  // Auth
  async register(params: { username: string; display_name: string; password: string; device_name?: string }): Promise<AuthSession> {
    const res = await this.request<AuthSession>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    this.setToken(res.token);
    return res;
  }

  async login(params: { username: string; password: string; device_name?: string }): Promise<AuthSession> {
    const res = await this.request<AuthSession>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    this.setToken(res.token);
    return res;
  }

  async getMe(): Promise<User> {
    return this.request<User>('/api/v1/auth/me');
  }

  async logout(): Promise<void> {
    try {
      await this.request<{ status: string }>('/api/v1/auth/logout', { method: 'POST' });
    } catch (e) {
      console.warn('Backend logout error:', e);
    } finally {
      this.setToken(null);
    }
  }

  // Users & Profiles
  async searchUsers(query: string): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>(`/api/v1/users?query=${encodeURIComponent(query)}`);
  }

  async getUserProfile(userId: string): Promise<User> {
    return this.request<User>(`/api/v1/users/${userId}`);
  }

  async updateProfile(params: { display_name?: string; bio?: string; avatar_url?: string }): Promise<User> {
    return this.request<User>('/api/v1/users/profile', {
      method: 'PUT',
      body: JSON.stringify(params),
    });
  }

  async uploadAvatar(file: Blob | File): Promise<User> {
    const formData = new FormData();
    formData.append('avatar', file, file instanceof File ? file.name : 'avatar.png');

    const token = this.getToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch('/api/v1/users/avatar', {
      method: 'POST',
      headers,
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Avatar upload failed: ${errText}`);
    }
    return res.json();
  }

  async deleteAvatar(): Promise<User> {
    return this.request<User>('/api/v1/users/avatar', {
      method: 'DELETE',
    });
  }

  async listDevices(): Promise<Device[]> {
    return this.request<Device[]>('/api/v1/users/devices');
  }

  async revokeDevice(deviceId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/users/devices/${deviceId}`, {
      method: 'DELETE',
    });
  }

  async getUserPreferences(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/api/v1/users/preferences');
  }

  async setUserPreferences(prefs: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/api/v1/users/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
  }

  async blockUser(userId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/users/block/${userId}`, {
      method: 'POST',
    });
  }

  async unblockUser(userId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/users/block/${userId}`, {
      method: 'DELETE',
    });
  }

  async checkBlock(userId: string): Promise<{ blocked: boolean }> {
    return this.request<{ blocked: boolean }>(`/api/v1/users/block/${userId}`);
  }

  async checkBlockUser(userId: string): Promise<{ blocked: boolean }> {
    return this.checkBlock(userId);
  }

  // Conversations
  async listConversations(): Promise<{ conversations: Conversation[] }> {
    return this.request<{ conversations: Conversation[] }>('/api/v1/conversations');
  }

  async createDirectConversation(participantUserId: string): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'direct',
        participant_user_id: participantUserId,
      }),
    });
  }

  async createGroupConversation(title: string, memberIds: string[]): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'group',
        title,
        member_ids: memberIds,
      }),
    });
  }

  async createChannelConversation(title: string, description?: string): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'channel',
        title,
        description: description || '',
      }),
    });
  }

  async updateConversation(conversationId: string, params: { title?: string; description?: string; avatar_url?: string }): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}`, {
      method: 'PUT',
      body: JSON.stringify(params),
    });
  }

  async getConversation(id: string): Promise<Conversation> {
    return this.request<Conversation>(`/api/v1/conversations/${id}`);
  }

  async addConversationMember(conversationId: string, userId: string, role = 'member'): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/members`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role }),
    });
  }

  async getConversationMembers(conversationId: string): Promise<{ members: ConversationMemberDetail[]; count: number }> {
    return this.request<{ members: ConversationMemberDetail[]; count: number }>(`/api/v1/conversations/${conversationId}/members`, {
      method: 'GET',
    });
  }

  async removeConversationMember(conversationId: string, userId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/members/${userId}`, {
      method: 'DELETE',
    });
  }

  async setConversationSecurityMode(conversationId: string, securityMode: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/security-mode`, {
      method: 'POST',
      body: JSON.stringify({ security_mode: securityMode }),
    });
  }

  async deleteConversation(conversationId: string, scope: 'me' | 'both' = 'me'): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}?scope=${scope}`, {
      method: 'DELETE',
    });
  }

  // Messages
  async listMessages(conversationId: string, limit = 50): Promise<{ messages: Message[] }> {
    return this.request<{ messages: Message[] }>(`/api/v1/conversations/${conversationId}/messages?limit=${limit}`);
  }

  async submitMessage(
    conversationId: string,
    data: { ciphertext: string; nonce: string; idempotency_key?: string; reply_to_id?: string }
  ): Promise<Message> {
    return this.request<Message>(`/api/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async editMessage(conversationId: string, messageId: string, ciphertext: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ ciphertext }),
    });
  }

  async deleteMessage(conversationId: string, messageId: string, scope: 'me' | 'everyone' = 'everyone'): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/messages/${messageId}?scope=${scope}`, {
      method: 'DELETE',
    });
  }

  async addReaction(conversationId: string, messageId: string, emoji: string): Promise<{ status: string; reactions: string }> {
    return this.request<{ status: string; reactions: string }>(`/api/v1/conversations/${conversationId}/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    });
  }

  async pinMessage(conversationId: string, messageId: string, isPinned: boolean): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/pin`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId, is_pinned: isPinned }),
    });
  }

  // Attachments
  uploadAttachmentWithProgress(
    conversationId: string,
    file: Blob | File,
    filename?: string,
    isEncrypted: boolean = true,
    onProgress?: (loaded: number, total: number) => void,
    abortSignal?: AbortSignal
  ): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('conversation_id', conversationId);
      formData.append('file', file, filename || (file instanceof File ? file.name : 'attachment.bin'));
      formData.append('is_encrypted', isEncrypted ? 'true' : 'false');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/v1/attachments');

      const token = this.getToken();
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            onProgress(event.loaded, event.total);
          }
        };
      }

      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          xhr.abort();
          reject(new DOMException('Upload aborted by user', 'AbortError'));
        });
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            resolve(data);
          } catch {
            reject(new Error('Invalid response from server'));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.statusText || xhr.status}`));
        }
      };

      xhr.onerror = () => {
        reject(new Error('Network error during file upload'));
      };

      xhr.onabort = () => {
        reject(new DOMException('Upload cancelled', 'AbortError'));
      };

      xhr.send(formData);
    });
  }

  async uploadAttachment(
    conversationId: string,
    file: Blob | File,
    filename?: string,
    isEncrypted: boolean = true
  ): Promise<Attachment> {
    return this.uploadAttachmentWithProgress(conversationId, file, filename, isEncrypted);
  }

  async downloadAttachment(attachmentId: string): Promise<Blob> {
    const token = this.getToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(`/api/v1/attachments/${attachmentId}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }
    return res.blob();
  }

  // Signal & Legacy Crypto keys
  async registerKeys(deviceId: string, identityPublicKey: string, preKeys: string[] = []): Promise<{ status: string }> {
    return this.request<{ status: string }>('/api/v1/crypto/keys', {
      method: 'POST',
      body: JSON.stringify({
        device_id: deviceId,
        identity_public_key: identityPublicKey,
        pre_keys: preKeys,
      }),
    });
  }

  async registerSignalKeys(params: {
    device_id: string;
    identity_public_key: string;
    registration_id: number;
    signed_pre_key: string;
    pre_keys: string[];
  }): Promise<{ status: string }> {
    return this.request<{ status: string }>('/api/v1/crypto/keys', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getUserKeys(userId: string): Promise<UserKeyPackage> {
    return this.request<UserKeyPackage>(`/api/v1/crypto/keys/${userId}`);
  }

  // Stickers
  async listStickerPacks(): Promise<{ packs: StickerPack[] }> {
    return this.request<{ packs: StickerPack[] }>('/api/v1/stickers/packs');
  }

  async getStickerPack(id: string): Promise<StickerPack> {
    return this.request<StickerPack>(`/api/v1/stickers/packs/${id}`);
  }

  async installStickerPack(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/stickers/installed/${id}`, {
      method: 'POST',
    });
  }

  async uninstallStickerPack(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/stickers/installed/${id}`, {
      method: 'DELETE',
    });
  }

  async getInstalledStickers(): Promise<{ packs: StickerPack[] }> {
    return this.request<{ packs: StickerPack[] }>('/api/v1/stickers/installed');
  }

  // Calls
  async getCallLogs(): Promise<{ calls: CallLog[] }> {
    return this.request<{ calls: CallLog[] }>('/api/v1/calls/logs');
  }

  async createCallLog(params: {
    id?: string;
    conversation_id: string;
    receiver_id: string;
    call_type: 'audio' | 'video';
    status: 'completed' | 'missed' | 'rejected' | 'failed';
    duration_seconds: number;
  }): Promise<CallLog> {
    return this.request<CallLog>('/api/v1/calls/logs', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  // Custom Stickers
  async createUserStickerPack(params: {
    title: string;
    name: string;
    stickers: Array<{ emoji: string; asset_url: string; width?: number; height?: number }>;
  }): Promise<StickerPack> {
    return this.request<StickerPack>('/api/v1/stickers/packs', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getStickerPackByShareCode(code: string): Promise<StickerPack> {
    return this.request<StickerPack>(`/api/v1/stickers/share/${code}`);
  }

  // Voice Chat (Track B)
  async startOrJoinVoiceChat(conversationId: string): Promise<{ room: VoiceChatRoom; participants: VoiceChatParticipant[] }> {
    return this.request<{ room: VoiceChatRoom; participants: VoiceChatParticipant[] }>(`/api/v1/conversations/${conversationId}/voice-chat`, {
      method: 'POST',
    });
  }

  async getActiveVoiceChat(conversationId: string): Promise<{ room: VoiceChatRoom; participants: VoiceChatParticipant[] }> {
    return this.request<{ room: VoiceChatRoom; participants: VoiceChatParticipant[] }>(`/api/v1/conversations/${conversationId}/voice-chat`);
  }

  async leaveVoiceChat(conversationId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/voice-chat/leave`, {
      method: 'POST',
    });
  }

  async updateVoiceChatState(conversationId: string, state: { is_muted?: boolean; is_speaking?: boolean }): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/voice-chat/state`, {
      method: 'POST',
      body: JSON.stringify(state),
    });
  }

  async endVoiceChat(conversationId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/voice-chat`, {
      method: 'DELETE',
    });
  }

  // GIFs (Track F)
  async searchGIFs(query = ''): Promise<{ gifs: GIFItem[] }> {
    return this.request<{ gifs: GIFItem[] }>(`/api/v1/media/gifs?q=${encodeURIComponent(query)}`);
  }

  // Polls (Phase 12)
  async createPoll(conversationId: string, params: {
    question: string;
    options: string[];
    is_anonymous?: boolean;
    allows_multiple?: boolean;
    is_quiz?: boolean;
    correct_option?: number;
    explanation?: string;
  }): Promise<Poll> {
    return this.request<Poll>(`/api/v1/conversations/${conversationId}/polls`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async getPoll(conversationId: string, pollId: string): Promise<Poll> {
    return this.request<Poll>(`/api/v1/conversations/${conversationId}/polls/${pollId}`);
  }

  async votePoll(conversationId: string, pollId: string, optionId: number): Promise<Poll> {
    return this.request<Poll>(`/api/v1/conversations/${conversationId}/polls/${pollId}/vote`, {
      method: 'POST',
      body: JSON.stringify({ option_id: optionId }),
    });
  }

  async closePoll(conversationId: string, pollId: string): Promise<Poll> {
    return this.request<Poll>(`/api/v1/conversations/${conversationId}/polls/${pollId}/close`, {
      method: 'POST',
    });
  }

  // Stories (Phase 15)
  async createStory(params: {
    media_url: string;
    media_type?: 'photo' | 'video';
    caption?: string;
  }): Promise<Story> {
    return this.request<Story>('/api/v1/stories', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async listStories(): Promise<{ stories: Story[] }> {
    return this.request<{ stories: Story[] }>('/api/v1/stories');
  }

  async deleteStory(storyId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/stories/${storyId}`, {
      method: 'DELETE',
    });
  }

  // Scheduled Messages (Phase 15)
  async createScheduledMessage(conversationId: string, params: {
    ciphertext: string;
    nonce?: string;
    scheduled_for: string;
    is_silent?: boolean;
  }): Promise<ScheduledMessage> {
    return this.request<ScheduledMessage>(`/api/v1/conversations/${conversationId}/scheduled`, {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async scheduleMessage(conversationId: string, params: {
    ciphertext: string;
    nonce?: string;
    scheduled_for: string;
    is_silent?: boolean;
  }): Promise<ScheduledMessage> {
    return this.createScheduledMessage(conversationId, params);
  }

  async listScheduledMessages(conversationId: string): Promise<ScheduledMessage[]> {
    return this.request<ScheduledMessage[]>(`/api/v1/conversations/${conversationId}/scheduled`);
  }

  async deleteScheduledMessage(conversationId: string, msgId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/scheduled/${msgId}`, {
      method: 'DELETE',
    });
  }

  // Conversation Member Role (Phase 12/13)
  async getConversationRole(conversationId: string): Promise<{ role: string }> {
    return this.request<{ role: string }>(`/api/v1/conversations/${conversationId}/role`);
  }

  // Phase 16: Read Receipts & Read State
  async markConversationRead(conversationId: string, messageId?: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId || '' }),
    });
  }

  // Phase 16: Role Management (Promote/Demote Admins)
  async updateMemberRole(conversationId: string, userId: string, role: 'admin' | 'member'): Promise<{ status: string; role: string }> {
    return this.request<{ status: string; role: string }>(`/api/v1/conversations/${conversationId}/members/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  }

  // Phase 16: Authentic Token-Based Invites
  async createConversationInvite(conversationId: string, params?: { max_uses?: number; expires_in_hours?: number }): Promise<ConversationInvite> {
    return this.request<ConversationInvite>(`/api/v1/conversations/${conversationId}/invites`, {
      method: 'POST',
      body: JSON.stringify(params || {}),
    });
  }

  async listConversationInvites(conversationId: string): Promise<ConversationInvite[]> {
    return this.request<ConversationInvite[]>(`/api/v1/conversations/${conversationId}/invites`);
  }

  async revokeConversationInvite(conversationId: string, code: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/invites/${code}`, {
      method: 'DELETE',
    });
  }

  async getInvitePreview(code: string): Promise<{
    invite_code: string;
    conversation_id: string;
    title: string;
    type: string;
    avatar_url: string;
    description: string;
    participant_count: number;
    expires_at?: string;
  }> {
    return this.request(`/api/v1/invites/${code}`);
  }

  async joinConversationInvite(code: string): Promise<Conversation> {
    return this.request<Conversation>(`/api/v1/invites/${code}/join`, {
      method: 'POST',
    });
  }

  // Phase 16: Message Views
  async recordMessageView(conversationId: string, messageId: string): Promise<{ views_count: number }> {
    return this.request<{ views_count: number }>(`/api/v1/conversations/${conversationId}/messages/${messageId}/view`, {
      method: 'POST',
    });
  }

  // Phase 16: Disappearing Messages (TTL)
  async setConversationTTL(conversationId: string, ttl: number): Promise<{ status: string; ttl: number }> {
    return this.request<{ status: string; ttl: number }>(`/api/v1/conversations/${conversationId}/ttl`, {
      method: 'PUT',
      body: JSON.stringify({ ttl }),
    });
  }

  // Phase 16: Global Search
  async globalSearch(query: string): Promise<{
    channels: Array<{ id: string; type: string; title: string; description: string; avatar_url: string }>;
    users: User[];
    conversations: Conversation[];
  }> {
    return this.request(`/api/v1/search?q=${encodeURIComponent(query)}`);
  }

  // Phase 16: User Presence & Last Seen
  async getUserPresence(userId: string): Promise<UserPresence> {
    return this.request<UserPresence>(`/api/v1/presence/${userId}`);
  }

  async getBatchPresence(userIds: string[]): Promise<UserPresence[]> {
    if (!userIds || userIds.length === 0) return [];
    return this.request<UserPresence[]>('/api/v1/presence/batch', {
      method: 'POST',
      body: JSON.stringify({ user_ids: userIds }),
    });
  }

  // Phase 16: WebRTC Dynamic ICE Servers (STUN/TURN)
  async getIceServers(): Promise<IceServerConfig[]> {
    return this.request<IceServerConfig[]>('/api/v1/webrtc/ice-servers');
  }

  // Phase 16 & 17: Readers & Message-level Receipts
  async getMessageReaders(conversationId: string, messageId: string): Promise<MessageReader[]> {
    return this.request<MessageReader[]>(`/api/v1/conversations/${conversationId}/messages/${messageId}/readers`);
  }

  async recordMessageRead(conversationId: string, messageId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/messages/${messageId}/read`, {
      method: 'POST',
    });
  }

  async createBotToken(name: string, scope = 'messages:send'): Promise<{
    token: string;
    id: string;
    bot_id: string;
    name: string;
    scope: string;
    created_at: string;
  }> {
    return this.request('/api/v1/bots/tokens', {
      method: 'POST',
      body: JSON.stringify({ name, scope }),
    });
  }

  async listBotTokens(): Promise<Array<{
    id: string;
    bot_id: string;
    name: string;
    scope: string;
    created_at: string;
    is_revoked: boolean;
  }>> {
    return this.request('/api/v1/bots/tokens');
  }

  async revokeBotToken(tokenId: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/bots/tokens/${tokenId}`, {
      method: 'DELETE',
    });
  }

  async purgeExpiredMessages(): Promise<{ ok: boolean; purged_count: number }> {
    return this.request<{ ok: boolean; purged_count: number }>('/api/v1/messages/purge-expired', {
      method: 'POST',
    });
  }
}

export const api = new ApiClient();
