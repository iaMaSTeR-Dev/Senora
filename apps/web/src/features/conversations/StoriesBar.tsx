import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect } from 'react';
import { Story, User } from '../../app/types';
import { api } from '../../protocol/api';
import { Plus, X, Trash2, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';

interface StoriesBarProps {
  currentUser: User;
}

export const StoriesBar: React.FC<StoriesBarProps> = ({ currentUser }) => {
  const uiLang = useUILanguage();
  const [stories, setStories] = useState<Story[]>([]);
  const [activeStoryIdx, setActiveStoryIdx] = useState<number | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<'photo' | 'video'>('photo');
  const [caption, setCaption] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);

  const fetchStories = async () => {
    try {
      const res = await api.listStories();
      setStories(res.stories || []);
    } catch (e) {
      console.warn('Failed to load stories:', e);
    }
  };

  useEffect(() => {
    fetchStories();
    const interval = setInterval(fetchStories, 30000);
    return () => clearInterval(interval);
  }, []);

  // Timer for active story auto-advance
  useEffect(() => {
    if (activeStoryIdx === null) {
      setProgress(0);
      return;
    }

    if (isPaused) return;

    const interval = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          if (activeStoryIdx < stories.length - 1) {
            setActiveStoryIdx(activeStoryIdx + 1);
            return 0;
          } else {
            setActiveStoryIdx(null);
            return 0;
          }
        }
        return prev + 2; // 50 ticks * 100ms = 5 seconds
      });
    }, 100);

    return () => clearInterval(interval);
  }, [activeStoryIdx, isPaused, stories.length]);

  const handleCreateStory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mediaUrl.trim()) return;

    setSubmitting(true);
    try {
      await api.createStory({
        media_url: mediaUrl.trim(),
        media_type: mediaType,
        caption: caption.trim() || undefined,
      });
      setShowCreateModal(false);
      setMediaUrl('');
      setCaption('');
      await fetchStories();
    } catch (e) {
      console.error('Failed to create story:', e);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteStory = async (storyId: string) => {
    try {
      await api.deleteStory(storyId);
      setActiveStoryIdx(null);
      await fetchStories();
    } catch (e) {
      console.error('Failed to delete story:', e);
    }
  };

  const currentStory = activeStoryIdx !== null ? stories[activeStoryIdx] : null;

  return (
    <>
      {/* Horizontal Stories Bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-[#101921] bg-[#17212b] overflow-x-auto no-scrollbar">
        {/* Post Story Button */}
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex flex-col items-center flex-shrink-0 group cursor-pointer focus:outline-none w-14"
        >
          <div className="relative w-12 h-12 min-w-[48px] min-h-[48px] max-w-[48px] max-h-[48px] flex-shrink-0 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#3ca9e2] p-[2px] transition transform group-hover:scale-105">
            <div className="h-full w-full rounded-full bg-[#17212b] flex items-center justify-center overflow-hidden aspect-square">
              {currentUser.avatar_url ? (
                <img src={api.avatarURL(currentUser.avatar_url)} alt="" className="h-full w-full object-cover rounded-full" />
              ) : (
                <span className="text-sm font-bold text-white">
                  {currentUser.display_name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
            <div className="absolute -bottom-0.5 -right-0.5 bg-[#24A1DE] text-white rounded-full p-0.5 border-2 border-[#17212b]">
              <Plus size={12} strokeWidth={3} />
            </div>
          </div>
          <span className="text-[10px] text-[#7f91a4] group-hover:text-white mt-1 font-medium truncate max-w-[56px] text-center">{uiText("My Story", uiLang)}</span>
        </button>

        {/* Stories list */}
        {stories.map((st, idx) => (
          <button
            key={st.id}
            onClick={() => {
              setActiveStoryIdx(idx);
              setProgress(0);
            }}
            className="flex flex-col items-center flex-shrink-0 group cursor-pointer focus:outline-none w-14"
          >
            <div className="w-12 h-12 min-w-[48px] min-h-[48px] max-w-[48px] max-h-[48px] flex-shrink-0 rounded-full bg-gradient-to-tr from-cyan-400 via-blue-500 to-purple-600 p-[2px] transition transform group-hover:scale-105 shadow-md shadow-blue-500/10">
              <div className="h-full w-full rounded-full bg-[#17212b] flex items-center justify-center overflow-hidden aspect-square">
                {st.avatar_url ? (
                  <img src={api.avatarURL(st.avatar_url)} alt="" className="h-full w-full object-cover rounded-full" />
                ) : (
                  <span className="text-sm font-bold text-white">
                    {(st.display_name || st.username || 'U').charAt(0).toUpperCase()}
                  </span>
                )}
              </div>
            </div>
            <span className="text-[10px] text-slate-300 group-hover:text-white mt-1 font-medium truncate max-w-[56px] text-center">
              {st.display_name || st.username}
            </span>
          </button>
        ))}
      </div>

      {/* Story Viewer Modal */}
      {currentStory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md animate-fadeIn">
          {/* Progress bar at top */}
          <div className="absolute top-4 left-4 right-4 max-w-lg mx-auto flex gap-1 z-20">
            {stories.map((_, i) => (
              <div key={i} className="flex-1 h-1 bg-white/30 rounded-full overflow-hidden">
                <div
                  className="h-full bg-white transition-all duration-100"
                  style={{
                    width:
                      i < (activeStoryIdx || 0)
                        ? '100%'
                        : i === activeStoryIdx
                        ? `${progress}%`
                        : '0%',
                  }}
                />
              </div>
            ))}
          </div>

          {/* Header */}
          <div className="absolute top-8 left-4 right-4 max-w-lg mx-auto flex items-center justify-between z-20 px-2">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-full overflow-hidden bg-primary-600 flex items-center justify-center text-white font-bold text-xs border border-white/20">
                {currentStory.avatar_url ? (
                  <img src={api.avatarURL(currentStory.avatar_url)} alt="" className="h-full w-full object-cover" />
                ) : (
                  (currentStory.display_name || 'U').charAt(0).toUpperCase()
                )}
              </div>
              <div>
                <p className="text-xs font-semibold text-white drop-shadow">
                  {currentStory.display_name || currentStory.username}
                </p>
                <p className="text-[10px] text-white/70 drop-shadow">
                  {new Date(currentStory.created_at).toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPaused(!isPaused)}
                className="text-white/80 hover:text-white p-1 rounded-full transition"
                title={isPaused ? uiText("Resume", uiLang) : uiText("Pause", uiLang)}
              >
                {isPaused ? <Play size={18} /> : <Pause size={18} />}
              </button>

              {currentStory.user_id === currentUser.id && (
                <button
                  onClick={() => handleDeleteStory(currentStory.id)}
                  className="text-red-400 hover:text-red-300 p-1 rounded-full transition"
                  title={uiText("Delete Story", uiLang)}
                >
                  <Trash2 size={18} />
                </button>
              )}

              <button
                onClick={() => setActiveStoryIdx(null)}
                className="text-white/80 hover:text-white p-1 rounded-full transition"
                title={uiText("Close", uiLang)}
              >
                <X size={20} />
              </button>
            </div>
          </div>

          {/* Main Media Content */}
          <div className="relative max-w-md w-full h-[75vh] flex flex-col items-center justify-center rounded-2xl overflow-hidden bg-black/60 shadow-2xl">
            {currentStory.media_type === 'video' ? (
              <video
                src={currentStory.media_url}
                autoPlay
                playsInline
                controls={false}
                className="w-full h-full object-contain"
              />
            ) : (
              <img
                src={currentStory.media_url}
                alt=""
                className="w-full h-full object-contain select-none"
              />
            )}

            {/* Caption */}
            {currentStory.caption && (
              <div className="absolute bottom-4 left-4 right-4 bg-black/70 backdrop-blur-sm p-3 rounded-xl border border-white/10 text-center">
                <p className="text-xs text-white font-medium">{currentStory.caption}</p>
              </div>
            )}
          </div>

          {/* Prev / Next controls */}
          {activeStoryIdx !== null && activeStoryIdx > 0 && (
            <button
              onClick={() => {
                if (activeStoryIdx !== null) {
                  setActiveStoryIdx(activeStoryIdx - 1);
                  setProgress(0);
                }
              }}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition z-20"
            >
              <ChevronLeft size={24} />
            </button>
          )}

          {activeStoryIdx !== null && activeStoryIdx < stories.length - 1 && (
            <button
              onClick={() => {
                if (activeStoryIdx !== null) {
                  setActiveStoryIdx(activeStoryIdx + 1);
                  setProgress(0);
                }
              }}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition z-20"
            >
              <ChevronRight size={24} />
            </button>
          )}
        </div>
      )}

      {/* Create Story Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#17212b] border border-[#2b5278] rounded-2xl p-6 shadow-2xl animate-scaleUp">
            <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
              <h3 className="text-base font-bold text-white">{uiText("Create New Story", uiLang)}</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-[#7f91a4] hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateStory} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-[#7f91a4] uppercase tracking-wider mb-1">{uiText("Media Type", uiLang)}</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMediaType('photo')}
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition ${
                      mediaType === 'photo'
                        ? 'bg-[#24A1DE] border-[#24A1DE] text-white'
                        : 'bg-[#242f3d] border-[#101921] text-[#7f91a4] hover:text-white'
                    }`}
                  >{uiText("Photo", uiLang)}</button>
                  <button
                    type="button"
                    onClick={() => setMediaType('video')}
                    className={`flex-1 py-2 text-xs font-semibold rounded-lg border transition ${
                      mediaType === 'video'
                        ? 'bg-[#24A1DE] border-[#24A1DE] text-white'
                        : 'bg-[#242f3d] border-[#101921] text-[#7f91a4] hover:text-white'
                    }`}
                  >{uiText("Video", uiLang)}</button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#7f91a4] uppercase tracking-wider mb-1">{uiText("Media URL (Image or Video)", uiLang)}</label>
                <input
                  type="url"
                  required
                  placeholder="https://images.unsplash.com/photo-..."
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-[#242f3d] border border-[#101921] rounded-lg text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#7f91a4] uppercase tracking-wider mb-1">{uiText("Caption (Optional)", uiLang)}</label>
                <input
                  type="text"
                  maxLength={140}
                  placeholder={uiText("What's happening?", uiLang)}
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  className="w-full px-3 py-2 bg-[#242f3d] border border-[#101921] rounded-lg text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                />
              </div>

              <div className="pt-2 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 text-xs font-semibold text-[#7f91a4] hover:text-white transition"
                >{uiText("Cancel", uiLang)}</button>
                <button
                  type="submit"
                  disabled={submitting || !mediaUrl.trim()}
                  className="px-5 py-2 text-xs font-semibold bg-[#24A1DE] hover:bg-[#1b8bc2] text-white rounded-lg transition disabled:opacity-50"
                >
                  {submitting ? uiText("Posting...", uiLang) : uiText("Post Story (24h)", uiLang)}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};
