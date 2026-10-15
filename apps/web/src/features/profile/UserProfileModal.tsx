import React, { useState, useEffect } from 'react';
import { User } from '../../app/types';
import { api } from '../../protocol/api';
import { Language, translations } from '../../app/i18n';
import { useUserPresence } from '../presence/presenceManager';
import { AvatarUploadModal } from '../settings/AvatarUploadModal';
import { MediaLightbox } from '../messages/MediaLightbox';
import {
  X,
  Phone,
  Video,
  MessageSquare,
  Copy,
  Check,
  Edit3,
  Camera,
  Folder,
  ShieldCheck,
  Calendar,
  Save,
  CheckCircle,
  Clock,
  UserX
} from 'lucide-react';

interface UserProfileModalProps {
  user: User;
  currentUser: User;
  conversationId?: string;
  onClose: () => void;
  onStartCall?: (type: 'audio' | 'video') => void;
  onOpenDirectChat?: (user: User) => void;
  onOpenSharedMedia?: () => void;
  onUpdateCurrentUser?: (updated: User) => void;
  lang: Language;
}

export const UserProfileModal: React.FC<UserProfileModalProps> = ({
  user,
  currentUser,
  onClose,
  onStartCall,
  onOpenDirectChat,
  onOpenSharedMedia,
  onUpdateCurrentUser,
  lang,
}) => {
  const isOwnProfile = currentUser.id === user.id;
  const [profileUser, setProfileUser] = useState<User>(user);
  const [loadingProfile, setLoadingProfile] = useState(false);
  const [copiedUsername, setCopiedUsername] = useState(false);
  const [copiedId, setCopiedId] = useState(false);

  // Edit Profile States (for own profile)
  const [isEditing, setIsEditing] = useState(false);
  const [displayName, setDisplayName] = useState(user.display_name || '');
  const [bio, setBio] = useState(user.bio || '');
  const [saving, setSaving] = useState(false);
  const [editSuccess, setEditSuccess] = useState(false);
  const [showAvatarUploadModal, setShowAvatarUploadModal] = useState(false);

  // Lightbox for full size avatar viewing
  const [showAvatarLightbox, setShowAvatarLightbox] = useState(false);

  const t = translations[lang];
  const presence = useUserPresence(profileUser.id, lang);

  // Fetch freshest public profile from backend
  useEffect(() => {
    if (user.id) {
      setLoadingProfile(true);
      api.getUserProfile(user.id)
        .then((fresh) => {
          setProfileUser(fresh);
          setDisplayName(fresh.display_name || '');
          setBio(fresh.bio || '');
        })
        .catch(() => {
          // Fall back to provided user prop
          setProfileUser(user);
        })
        .finally(() => setLoadingProfile(false));
    }
  }, [user.id]);

  // Block state for peer user
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockingLoading, setBlockingLoading] = useState(false);

  useEffect(() => {
    if (!isOwnProfile && user.id) {
      api.checkBlockUser(user.id)
        .then((res) => setIsBlocked(res.blocked))
        .catch(() => {});
    }
  }, [user.id, isOwnProfile]);

  const handleToggleBlock = async () => {
    setBlockingLoading(true);
    try {
      if (isBlocked) {
        await api.unblockUser(user.id);
        setIsBlocked(false);
      } else {
        await api.blockUser(user.id);
        setIsBlocked(true);
      }
    } catch (err: any) {
      alert(`Failed to update block status: ${err.message}`);
    } finally {
      setBlockingLoading(false);
    }
  };

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleCopyUsername = () => {
    if (profileUser.username) {
      navigator.clipboard.writeText(`@${profileUser.username}`);
      setCopiedUsername(true);
      setTimeout(() => setCopiedUsername(false), 2000);
    }
  };

  const handleCopyId = () => {
    if (profileUser.id) {
      navigator.clipboard.writeText(profileUser.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 2000);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setEditSuccess(false);
    try {
      const updated = await api.updateProfile({
        display_name: displayName.trim(),
        bio: bio.trim(),
      });
      setProfileUser(updated);
      if (onUpdateCurrentUser) {
        onUpdateCurrentUser(updated);
      }
      setEditSuccess(true);
      setTimeout(() => {
        setEditSuccess(false);
        setIsEditing(false);
      }, 1500);
    } catch (err: any) {
      alert(`Failed to update profile: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const initials = (profileUser.display_name || profileUser.username || 'U')
    .charAt(0)
    .toUpperCase();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn select-none">
      <div className="relative w-full max-w-md bg-[#17212b] border border-[#242f3d] rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Modal Top Bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[#242f3d] bg-[#1f2b38]/70">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white">
              {isOwnProfile ? (lang === 'fa' ? 'پروفایل شما' : 'Your Profile') : (lang === 'fa' ? 'اطلاعات کاربر' : 'User Info')}
            </span>
            {loadingProfile && (
              <div className="h-3 w-3 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
            )}
            {isOwnProfile && (
              <span className="px-2 py-0.5 rounded-full bg-[#24A1DE]/20 text-[#24A1DE] text-[10px] font-bold">
                {lang === 'fa' ? 'شما' : 'You'}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-[#7f91a4] hover:text-white rounded-xl hover:bg-[#242f3d] transition-colors cursor-pointer"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Header Hero with Large Avatar */}
          <div className="relative px-6 pt-8 pb-6 bg-gradient-to-b from-[#1f2b38] to-[#17212b] flex flex-col items-center text-center border-b border-[#242f3d]/60">
            {/* Avatar */}
            <div className="relative group mb-4">
              <div
                onClick={() => {
                  if (profileUser.avatar_url) {
                    setShowAvatarLightbox(true);
                  }
                }}
                className={`w-28 h-28 rounded-full overflow-hidden shadow-2xl border-4 border-[#17212b] bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center font-bold text-4xl text-white ${
                  profileUser.avatar_url ? 'cursor-pointer hover:opacity-95 transition' : ''
                }`}
                title={profileUser.avatar_url ? 'Click to view photo' : undefined}
              >
                {profileUser.avatar_url ? (
                  <img
                    src={profileUser.avatar_url}
                    alt={profileUser.display_name}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                ) : (
                  initials
                )}
              </div>

              {isOwnProfile && (
                <button
                  type="button"
                  onClick={() => setShowAvatarUploadModal(true)}
                  className="absolute bottom-0 right-0 p-2.5 rounded-full bg-[#24A1DE] hover:bg-[#208fc4] text-white shadow-lg border-2 border-[#17212b] transition-transform hover:scale-110 active:scale-95 cursor-pointer"
                  title="Change avatar photo"
                >
                  <Camera size={16} />
                </button>
              )}
            </div>

            {/* Display Name & Online Status */}
            <h2 className="text-xl font-bold text-white tracking-wide truncate max-w-full">
              {profileUser.display_name || profileUser.username}
            </h2>

            <p className="text-xs text-[#24A1DE] font-mono mt-0.5">
              @{profileUser.username}
            </p>

            <div className={`flex items-center gap-1.5 text-xs font-medium mt-2 ${presence.isOnline ? 'text-emerald-400' : 'text-[#7f91a4]'}`}>
              {presence.isOnline && <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />}
              <span>{presence.formattedLastSeen}</span>
            </div>
          </div>

          {/* Action Buttons Row */}
          <div className="p-4 border-b border-[#242f3d] bg-[#17212b] flex items-center justify-around gap-2">
            {!isOwnProfile && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (onOpenDirectChat) {
                      onOpenDirectChat(profileUser);
                      onClose();
                    }
                  }}
                  className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-[#242f3d] transition group flex-1 cursor-pointer"
                >
                  <div className="w-10 h-10 rounded-full bg-[#24A1DE]/20 group-hover:bg-[#24A1DE] text-[#24A1DE] group-hover:text-white flex items-center justify-center transition shadow-sm">
                    <MessageSquare size={18} />
                  </div>
                  <span className="text-[11px] font-semibold text-slate-300 group-hover:text-white">
                    {lang === 'fa' ? 'پیام' : 'Message'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (onStartCall) {
                      onStartCall('audio');
                      onClose();
                    }
                  }}
                  className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-[#242f3d] transition group flex-1 cursor-pointer"
                >
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 group-hover:bg-emerald-600 text-emerald-400 group-hover:text-white flex items-center justify-center transition shadow-sm">
                    <Phone size={18} />
                  </div>
                  <span className="text-[11px] font-semibold text-slate-300 group-hover:text-white">
                    {lang === 'fa' ? 'تماس صوتی' : 'Voice Call'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    if (onStartCall) {
                      onStartCall('video');
                      onClose();
                    }
                  }}
                  className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-[#242f3d] transition group flex-1 cursor-pointer"
                >
                  <div className="w-10 h-10 rounded-full bg-indigo-500/20 group-hover:bg-indigo-600 text-indigo-400 group-hover:text-white flex items-center justify-center transition shadow-sm">
                    <Video size={18} />
                  </div>
                  <span className="text-[11px] font-semibold text-slate-300 group-hover:text-white">
                    {lang === 'fa' ? 'تماس تصویری' : 'Video Call'}
                  </span>
                </button>
              </>
            )}

            {onOpenSharedMedia && (
              <button
                type="button"
                onClick={() => {
                  onOpenSharedMedia();
                  onClose();
                }}
                className="flex flex-col items-center gap-1.5 p-2 rounded-2xl hover:bg-[#242f3d] transition group flex-1 cursor-pointer"
              >
                <div className="w-10 h-10 rounded-full bg-purple-500/20 group-hover:bg-purple-600 text-purple-400 group-hover:text-white flex items-center justify-center transition shadow-sm">
                  <Folder size={18} />
                </div>
                <span className="text-[11px] font-semibold text-slate-300 group-hover:text-white">
                  {lang === 'fa' ? 'رسانه‌ها' : 'Media'}
                </span>
              </button>
            )}

            {isOwnProfile && (
              <button
                type="button"
                onClick={() => setIsEditing(!isEditing)}
                className={`flex flex-col items-center gap-1.5 p-2 rounded-2xl transition group flex-1 cursor-pointer ${
                  isEditing ? 'bg-[#24A1DE]/20 text-[#24A1DE]' : 'hover:bg-[#242f3d]'
                }`}
              >
                <div className="w-10 h-10 rounded-full bg-[#24A1DE]/20 group-hover:bg-[#24A1DE] text-[#24A1DE] group-hover:text-white flex items-center justify-center transition shadow-sm">
                  <Edit3 size={18} />
                </div>
                <span className="text-[11px] font-semibold text-slate-300 group-hover:text-white">
                  {isEditing ? (lang === 'fa' ? 'لغو ویرایش' : 'Cancel') : (lang === 'fa' ? 'ویرایش پروفایل' : 'Edit Profile')}
                </span>
              </button>
            )}
          </div>

          {/* Details / Edit Form */}
          <div className="p-5 space-y-4 text-xs">
            {isEditing && isOwnProfile ? (
              /* Profile Edit Form */
              <form onSubmit={handleSaveProfile} className="space-y-4 animate-fadeIn">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    {t.display_name}
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your display name"
                    className="w-full px-3.5 py-2 rounded-xl bg-[#242f3d] border border-[#324252] text-xs text-white focus:outline-none focus:border-[#24A1DE]"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-400 mb-1">
                    {t.bio}
                  </label>
                  <textarea
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    rows={3}
                    placeholder="A few words about you..."
                    className="w-full px-3.5 py-2 rounded-xl bg-[#242f3d] border border-[#324252] text-xs text-white focus:outline-none focus:border-[#24A1DE] resize-none"
                  />
                </div>

                {editSuccess && (
                  <div className="p-2.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 flex items-center gap-2">
                    <CheckCircle size={15} />
                    <span>Profile saved successfully!</span>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="flex-1 py-2.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs text-slate-300 font-semibold transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs text-white font-bold transition flex items-center justify-center gap-1.5 shadow-md shadow-[#24A1DE]/25 disabled:opacity-50 cursor-pointer"
                  >
                    <Save size={14} />
                    <span>{saving ? 'Saving...' : t.save}</span>
                  </button>
                </div>
              </form>
            ) : (
              /* Public / Read-Only Profile Information */
              <div className="space-y-3.5">
                {/* Username */}
                <div className="flex items-center justify-between p-3 rounded-2xl bg-[#242f3d]/60 border border-[#242f3d]">
                  <div className="min-w-0">
                    <span className="text-[10px] text-[#7f91a4] uppercase font-bold tracking-wider block">
                      {lang === 'fa' ? 'نام کاربری' : 'Username'}
                    </span>
                    <span className="text-sm font-semibold text-white font-mono truncate block mt-0.5">
                      @{profileUser.username}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyUsername}
                    className="p-2 rounded-xl bg-[#17212b] hover:bg-[#121921] text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer"
                    title="Copy username"
                  >
                    {copiedUsername ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
                  </button>
                </div>

                {/* Bio */}
                {profileUser.bio ? (
                  <div className="p-3 rounded-2xl bg-[#242f3d]/60 border border-[#242f3d]">
                    <span className="text-[10px] text-[#7f91a4] uppercase font-bold tracking-wider block mb-1">
                      {t.bio}
                    </span>
                    <p className="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap break-words">
                      {profileUser.bio}
                    </p>
                  </div>
                ) : (
                  <div className="p-3 rounded-2xl bg-[#242f3d]/30 border border-[#242f3d]/50 text-slate-400 italic text-[11px]">
                    No bio written yet.
                  </div>
                )}

                {/* Account Details & Security */}
                <div className="p-3 rounded-2xl bg-[#242f3d]/60 border border-[#242f3d] space-y-2.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[#7f91a4] flex items-center gap-1.5">
                      <ShieldCheck size={14} className="text-emerald-400" />
                      <span>Security</span>
                    </span>
                    <span className="text-emerald-400 font-semibold">Signal Protocol E2EE</span>
                  </div>

                  {profileUser.created_at && (
                    <div className="flex items-center justify-between text-xs pt-1.5 border-t border-[#17212b]/50">
                      <span className="text-[#7f91a4] flex items-center gap-1.5">
                        <Calendar size={14} className="text-[#24A1DE]" />
                        <span>Registered</span>
                      </span>
                      <span className="text-slate-300 font-medium">
                        {new Date(profileUser.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs pt-1.5 border-t border-[#17212b]/50">
                    <span className="text-[#7f91a4] flex items-center gap-1.5">
                      <Clock size={14} className="text-amber-400" />
                      <span>Public ID</span>
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyId}
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#24A1DE] hover:underline cursor-pointer"
                      title="Click to copy public ID"
                    >
                      <span>{profileUser.id.substring(0, 12)}...</span>
                      {copiedId ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    </button>
                  </div>
                </div>

                {/* Block / Unblock User Action (Requirement 2.4) */}
                {!isOwnProfile && (
                  <button
                    type="button"
                    onClick={handleToggleBlock}
                    disabled={blockingLoading}
                    className={`w-full py-2.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer ${
                      isBlocked
                        ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/30'
                        : 'bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30'
                    }`}
                  >
                    <UserX size={15} />
                    <span>
                      {blockingLoading
                        ? 'Updating...'
                        : isBlocked
                        ? lang === 'fa'
                          ? 'رفع مسدودیت کاربر'
                          : 'Unblock User'
                        : lang === 'fa'
                        ? 'مسدود کردن کاربر'
                        : 'Block User'}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-3.5 border-t border-[#242f3d] bg-[#1f2b38]/40">
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs font-semibold text-white transition cursor-pointer"
          >
            {lang === 'fa' ? 'بستن' : 'Close'}
          </button>
        </div>
      </div>

      {/* Avatar Lightbox for full screen viewing */}
      {showAvatarLightbox && profileUser.avatar_url && (
        <MediaLightbox
          media={{
            id: 'avatar_full',
            url: profileUser.avatar_url,
            type: 'photo',
            filename: `${profileUser.username}_avatar.png`,
            senderName: profileUser.display_name || profileUser.username,
            date: profileUser.created_at ? new Date(profileUser.created_at).toLocaleDateString() : undefined,
          }}
          onClose={() => setShowAvatarLightbox(false)}
        />
      )}

      {/* Avatar Upload / Crop Modal for own profile */}
      {showAvatarUploadModal && (
        <AvatarUploadModal
          currentUser={currentUser}
          onClose={() => setShowAvatarUploadModal(false)}
          onSuccess={(updated) => {
            setProfileUser(updated);
            if (onUpdateCurrentUser) {
              onUpdateCurrentUser(updated);
            }
          }}
        />
      )}
    </div>
  );
};
