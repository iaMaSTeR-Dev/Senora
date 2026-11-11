import { Attachment, AuthSession, CallLog, Conversation, ConversationInvite, ConversationMemberDetail, ConversationPin, Device, ForumTopic, GIFItem, IceServerConfig, MediaShare, Message, MessageReader, Poll, ScheduledMessage, ServerStats, Sticker, StickerPack, StorageStatus, Story, User, UserKeyPackage, UserPresence, VoiceChatParticipant, VoiceChatRoom, WatchPartySession } from '../app/types';
import { serverManager } from './serverManager';

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
      this.token = localStorage.getItem('senora_token');
    }
    return this.token;
  }

  endpointURL(endpoint: string): string {
    const base = serverManager.getActiveServer().url || (typeof window !== 'undefined' ? window.location?.origin : '') || 'http://localhost';
    const target = new URL(endpoint, base);
    if (target.origin !== new URL(base).origin) throw new Error('API endpoint must belong to the active server');
    return target.toString();
  }

  avatarURL(value?: string): string {
    if (!value) return '';
    const base = serverManager.getActiveServer().url || (typeof window !== 'undefined' ? window.location?.origin : '') || 'http://localhost';
    const target = new URL(value, base);
    if (target.origin === new URL(base).origin && target.pathname.startsWith('/api/v1/attachments/avatar/')) {
      const token = this.getToken(); if (token) target.searchParams.set('auth', token);
    }
    return target.toString();
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, tokenOverride?: string): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const token = tokenOverride || this.getToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const url = this.endpointURL(endpoint);

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      let errorMsg = `HTTP Error ${res.status}`;
      let errorCode: string | undefined;
      try {
        const errJson = await res.json();
        errorCode = errJson?.error?.code;
        if (errJson?.error?.message) {
          errorMsg = errJson.error.message;
        }
      } catch {
        // Fallback to text
      }
      const error: any = new Error(errorMsg);
      error.status = res.status;
      error.code = errorCode;
      throw error;
    }

    return res.json() as Promise<T>;
  }

  // Auth
  async register(params: { username: string; display_name: string; password: string; device_name?: string }): Promise<AuthSession> {
    const res = await this.request<AuthSession>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (res.token) {
      this.setToken(res.token);
    }
    return res;
  }

  async login(params: { username: string; password: string; device_name?: string }): Promise<AuthSession> {
    const res = await this.request<AuthSession>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    if (res.token) {
      this.setToken(res.token);
    }
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

  async getUserByUsername(username: string): Promise<User> {
    const clean = username.replace(/^@/, '').trim();
    return this.request<User>(`/api/v1/users/by-username/${encodeURIComponent(clean)}`);
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

    const res = await fetch(this.endpointURL('/api/v1/users/avatar'), {
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

  async listDevices(tokenOverride?: string): Promise<Device[]> {
    return this.request<Device[]>('/api/v1/users/devices', {}, tokenOverride);
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

  async createChannelConversation(title: string, description?: string, username?: string): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/conversations', {
      method: 'POST',
      body: JSON.stringify({
        type: 'channel',
        title,
        description: description || '',
        username: username || '',
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
    data: { ciphertext: string; attachment_ids?: string[]; nonce: string; idempotency_key?: string; reply_to_id?: string; topic_id?: string }
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

  async deleteMessage(conversationId: string, messageId: string, scope: 'me' | 'everyone' = 'everyone', attachmentIds: string[] = []): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/messages/${messageId}?scope=${scope}`, {
      method: 'DELETE',
      body: JSON.stringify({ attachment_ids: attachmentIds }),
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
    onProgress?: (percent: number, loaded: number, total: number) => void,
    abortSignal?: AbortSignal,
    isViewOnce?: boolean
  ): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('conversation_id', conversationId);
      formData.append('file', file, filename || (file instanceof File ? file.name : 'attachment.bin'));
      formData.append('is_encrypted', isEncrypted ? 'true' : 'false');
      if (isViewOnce) {
        formData.append('is_view_once', 'true');
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.endpointURL('/api/v1/attachments'));

      const token = this.getToken();
      if (token) {
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      }

      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && event.total > 0) {
            const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
            onProgress(percent, event.loaded, event.total);
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
    isEncrypted: boolean = true,
    isViewOnce?: boolean
  ): Promise<Attachment> {
    return this.uploadAttachmentWithProgress(conversationId, file, filename, isEncrypted, undefined, undefined, isViewOnce);
  }

  async downloadAttachment(attachmentId: string): Promise<Blob> {
    const token = this.getToken();
    const headers = new Headers();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const res = await fetch(this.endpointURL(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`), {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(`Download failed: HTTP ${res.status}`);
    }
    return res.blob();
  }

  attachmentStreamURL(attachmentId: string): string {
    const url = new URL(this.endpointURL(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`), window.location.origin);
    const token = this.getToken();
    if (token) url.searchParams.set('auth', token);
    return url.toString();
  }

  openBotFather(): Promise<Conversation> {
    return this.request<Conversation>('/api/v1/botfather/open', { method: 'POST' });
  }

  invokeBotCallback(conversationId: string, messageId: string, data: string): Promise<{id: string}> {
    return this.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/bot-callback`, {
      method: 'POST', body: JSON.stringify({data}),
    });
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
  }, tokenOverride?: string): Promise<{ status: string }> {
    return this.request<{ status: string }>('/api/v1/crypto/keys', {
      method: 'POST',
      body: JSON.stringify(params),
    }, tokenOverride);
  }

  async getUserKeys(userId: string, tokenOverride?: string): Promise<UserKeyPackage> {
    return this.request<UserKeyPackage>(`/api/v1/crypto/keys/${encodeURIComponent(userId)}`, {}, tokenOverride);
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

  async deleteStickerPack(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/stickers/packs/${id}`, {
      method: 'DELETE',
    });
  }

  async deleteSticker(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/stickers/${id}`, {
      method: 'DELETE',
    });
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

  async addStickerToPack(
    packId: string,
    sticker: { emoji: string; asset_url: string; width?: number; height?: number }
  ): Promise<Sticker> {
    return this.request<Sticker>(`/api/v1/stickers/packs/${packId}/stickers`, {
      method: 'POST',
      body: JSON.stringify(sticker),
    });
  }

  async uploadStickerAsset(dataUrl: string): Promise<{ url: string; id: string }> {
    return this.request<{ url: string; id: string }>('/api/v1/stickers/upload-asset', {
      method: 'POST',
      body: JSON.stringify({ data_url: dataUrl }),
    });
  }

  // Link Previews
  async getLinkPreview(url: string, signal?: AbortSignal): Promise<{ url: string; title?: string; description?: string; image?: string; site_name?: string }> {
    return this.request(`/api/v1/links/preview?url=${encodeURIComponent(url)}`, { signal });
  }

  // Group Slow Mode
  async setConversationSlowMode(convId: string, seconds: number): Promise<{ status: string; slow_mode_seconds: number }> {
    return this.request(`/api/v1/conversations/${convId}/slow-mode`, {
      method: 'POST',
      body: JSON.stringify({ slow_mode_seconds: seconds }),
    });
  }

  // Self Destruct
  async setSelfDestructMonths(months: number): Promise<{ status: string; self_destruct_months: number }> {
    return this.request(`/api/v1/users/self-destruct`, {
      method: 'PUT',
      body: JSON.stringify({ months }),
    });
  }

  // Voice Chat
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

  // GIFs
  async searchGIFs(query = ''): Promise<{ gifs: GIFItem[] }> {
    return this.request<{ gifs: GIFItem[] }>(`/api/v1/media/gifs?q=${encodeURIComponent(query)}`);
  }

  // Polls
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

  // Stories
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

  // Scheduled Messages
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

  // Conversation Member Role
  async getConversationRole(conversationId: string): Promise<{ role: string }> {
    return this.request<{ role: string }>(`/api/v1/conversations/${conversationId}/role`);
  }

  // Read Receipts & Read State
  async markConversationRead(conversationId: string, messageId?: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(`/api/v1/conversations/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId || '' }),
    });
  }

  // Role Management (Promote/Demote Admins)
  async updateMemberRole(conversationId: string, userId: string, role: 'admin' | 'member'): Promise<{ status: string; role: string }> {
    return this.request<{ status: string; role: string }>(`/api/v1/conversations/${conversationId}/members/${userId}/role`, {
      method: 'PUT',
      body: JSON.stringify({ role }),
    });
  }

  // Authentic Token-Based Invites
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

  // Message Views
  async recordMessageView(conversationId: string, messageId: string): Promise<{ views_count: number }> {
    return this.request<{ views_count: number }>(`/api/v1/conversations/${conversationId}/messages/${messageId}/view`, {
      method: 'POST',
    });
  }

  // Disappearing Messages (TTL)
  async setConversationTTL(conversationId: string, ttl: number): Promise<{ status: string; ttl: number }> {
    return this.request<{ status: string; ttl: number }>(`/api/v1/conversations/${conversationId}/ttl`, {
      method: 'PUT',
      body: JSON.stringify({ ttl }),
    });
  }

  // Join Conversation directly by ID (Channel or Group)
  async joinConversation(conversationId: string): Promise<Conversation> {
    return this.request<Conversation>(`/api/v1/conversations/${conversationId}/join`, {
      method: 'POST',
    });
  }

  // Exact ID & Username Resolver (User, Channel, Group)
  async resolveIdentifier(identifier: string): Promise<{
    type: 'user' | 'channel' | 'group';
    user?: User;
    conversation?: Conversation;
    invite_code?: string;
  }> {
    const clean = identifier.replace(/^@/, '').trim();
    return this.request(`/api/v1/resolve/${encodeURIComponent(clean)}`);
  }

  // Global Search (Exact ID Lookup)
  async globalSearch(query: string): Promise<{
    channels: Array<{ id: string; type: string; title: string; description: string; avatar_url: string; username?: string }>;
    users: User[];
    conversations: Conversation[];
  }> {
    return this.request(`/api/v1/search?q=${encodeURIComponent(query)}`);
  }

  // User Presence & Last Seen
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

  // WebRTC Dynamic ICE Servers (STUN/TURN)
  async getIceServers(): Promise<IceServerConfig[]> {
    return this.request<IceServerConfig[]>('/api/v1/webrtc/ice-servers');
  }

  // Readers & Message-level Receipts
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

  // Master Bot & Server Administration
  async getAdminStatus(): Promise<{ is_owner: boolean; master_bot_enabled: boolean; registration_approval: boolean }> {
    return this.request('/api/v1/admin/status');
  }

  async getAdminStats(): Promise<{ status: string; stats: ServerStats }> {
    return this.request('/api/v1/admin/stats');
  }

  async listAdminUsers(): Promise<{ users: User[] }> {
    return this.request('/api/v1/admin/users');
  }

  async listPendingRegistrations(): Promise<{ users: User[]; pending_users: User[] }> {
    return this.request('/api/v1/admin/registrations');
  }

  async approveUser(userId: string): Promise<{ status: string; user_id: string }> {
    return this.request(`/api/v1/admin/users/${userId}/approve`, {
      method: 'POST',
    });
  }

  async rejectUser(userId: string): Promise<{ status: string; user_id: string }> {
    return this.request(`/api/v1/admin/users/${userId}/reject`, {
      method: 'POST',
    });
  }

  async banUser(userId: string): Promise<{ status: string; user_id: string }> {
    return this.request(`/api/v1/admin/users/${userId}/ban`, {
      method: 'POST',
    });
  }

  async unbanUser(userId: string): Promise<{ status: string; user_id: string }> {
    return this.request(`/api/v1/admin/users/${userId}/unban`, {
      method: 'POST',
    });
  }

  async deleteAdminUser(userId: string): Promise<{ status: string; user_id: string }> {
    return this.request(`/api/v1/admin/users/${userId}`, {
      method: 'DELETE',
    });
  }

  async listAdminConversations(): Promise<{ conversations: Conversation[] }> {
    return this.request('/api/v1/admin/conversations');
  }



  async executeBotAction(params: {
    action: string;
    conversation_id?: string;
    target_user_id?: string;
    command?: string;
  }): Promise<{ status: string; reply: Message }> {
    return this.request('/api/v1/admin/bot/action', {
      method: 'POST',
      body: JSON.stringify(params),
    });
  }

  async broadcastAnnouncement(message: string): Promise<{ status: string; reply: Message }> {
    return this.request('/api/v1/admin/broadcast', {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  async updateAdminSettings(settings: {
    registration_approval?: boolean;
    maintenance_mode?: boolean;
  }): Promise<{ status: string; registration_approval: boolean; maintenance_mode: boolean }> {
    return this.request('/api/v1/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    });
  }

  async getMasterBotConversation(): Promise<{ conversation: Conversation }> {
    return this.request('/api/v1/admin/bot/conversation');
  }

  // S3 & Local Dual-Engine Storage Diagnostics
  async getStorageStatus(): Promise<StorageStatus> {
    return this.request<StorageStatus>('/api/v1/storage/status');
  }

  // Supergroup Forum Topics
  async toggleConversationForum(conversationId: string, isForum: boolean): Promise<{ success: boolean; is_forum: boolean }> {
    return this.request(`/api/v1/conversations/${conversationId}/forum/toggle`, {
      method: 'POST',
      body: JSON.stringify({ is_forum: isForum }),
    });
  }

  async getConversationTopics(conversationId: string): Promise<{ topics: ForumTopic[] }> {
    return this.request(`/api/v1/conversations/${conversationId}/topics`);
  }

  async createConversationTopic(conversationId: string, title: string, icon: string, color: string): Promise<ForumTopic> {
    return this.request(`/api/v1/conversations/${conversationId}/topics`, {
      method: 'POST',
      body: JSON.stringify({ title, icon, color }),
    });
  }

  // Multiple Pinned Messages
  async getConversationPins(conversationId: string): Promise<{ pins: ConversationPin[] }> {
    return this.request(`/api/v1/conversations/${conversationId}/pins`);
  }

  async addConversationPin(conversationId: string, messageId: string): Promise<ConversationPin> {
    return this.request(`/api/v1/conversations/${conversationId}/pins`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    });
  }

  async removeConversationPin(conversationId: string, messageId: string): Promise<{ success: boolean }> {
    return this.request(`/api/v1/conversations/${conversationId}/pins/${messageId}`, {
      method: 'DELETE',
    });
  }

  // Media Shares & Standalone Streaming Player
  async createMediaShare(attachmentId: string, options?: { password?: string; expiresInHours?: number; maxDownloads?: number }): Promise<{ share: MediaShare }> {
    return this.request<{ share: MediaShare }>('/api/v1/media/share', {
      method: 'POST',
      body: JSON.stringify({
        attachment_id: attachmentId,
        password: options?.password,
        expires_in_hours: options?.expiresInHours,
        max_downloads: options?.maxDownloads,
      }),
    });
  }

  async getMediaShare(shareId: string): Promise<{ share: MediaShare }> {
    return this.request<{ share: MediaShare }>(`/api/v1/media/share/${shareId}`);
  }

  async deleteMediaShare(shareId: string): Promise<{ message: string }> {
    return this.request<{ message: string }>(`/api/v1/media/share/${shareId}`, {
      method: 'DELETE',
    });
  }

  // In-Chat Synchronized Watch Party
  async getWatchParty(conversationId: string): Promise<{ active: boolean; session: WatchPartySession | null }> {
    return this.request<{ active: boolean; session: WatchPartySession | null }>(`/api/v1/conversations/${conversationId}/watch-party`);
  }

  async sendWatchPartyAction(conversationId: string, action: { action: 'start' | 'sync' | 'reaction' | 'end'; [key: string]: any }): Promise<any> {
    return this.request(`/api/v1/conversations/${conversationId}/watch-party/action`, {
      method: 'POST',
      body: JSON.stringify(action),
    });
  }
}

export const api = new ApiClient();
