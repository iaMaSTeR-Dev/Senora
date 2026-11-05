import React, { useState } from 'react';
import { Poll } from '../../app/types';
import { api } from '../../protocol/api';
import { signalManager } from '../../crypto/signalManager';
import { Check, Lock, HelpCircle, AlertCircle } from 'lucide-react';

interface PollCardProps {
  pollId: string;
  conversationId: string;
  currentUserId: string;
  isOwnerOrAdmin?: boolean;
  pollKey?: string;
  pollIv?: string;
}

export const PollCard: React.FC<PollCardProps> = ({
  pollId,
  conversationId,
  currentUserId,
  isOwnerOrAdmin = false,
  pollKey,
  pollIv,
}) => {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [loading, setLoading] = useState(false);
  const [voting, setVoting] = useState(false);

  const decryptPoll = async (res: Poll | null): Promise<Poll | null> => {
    if (!res) return null;
    if (pollKey) {
      const decQuestion = await signalManager.decryptPollText(res.question, pollKey, pollIv);
      const decOptions = await Promise.all(
        (res.options || []).map(async (opt) => ({
          ...opt,
          text: await signalManager.decryptPollText(opt.text, pollKey, pollIv),
        }))
      );
      return { ...res, question: decQuestion, options: decOptions };
    }
    return res;
  };

  const fetchPoll = async () => {
    try {
      setLoading(true);
      const res = await api.getPoll(conversationId, pollId);
      const decrypted = await decryptPoll(res);
      setPoll(decrypted);
    } catch (e) {
      console.warn('Failed to load poll:', e);
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    fetchPoll();
  }, [pollId, conversationId, pollKey, pollIv]);

  if (loading && !poll) {
    return (
      <div className="p-4 bg-[#17212b] border border-[#242f3d] rounded-2xl w-full max-w-[280px] sm:w-80 text-center text-xs text-[#7f91a4] animate-pulse">
        Loading poll...
      </div>
    );
  }

  if (!poll) {
    return (
      <div className="p-4 bg-[#17212b] border border-[#242f3d] rounded-2xl w-full max-w-[280px] sm:w-80 text-center text-xs text-[#7f91a4]">
        Poll not available
      </div>
    );
  }

  const hasVoted = (poll.my_votes && poll.my_votes.length > 0) || false;
  const isCreator = poll.creator_id === currentUserId;
  const canClose = (isCreator || isOwnerOrAdmin) && !poll.is_closed;

  const handleVote = async (optionId: number) => {
    if (poll.is_closed || voting) return;
    try {
      setVoting(true);
      const updated = await api.votePoll(conversationId, pollId, optionId);
      const decrypted = await decryptPoll(updated);
      setPoll(decrypted);
    } catch (e: any) {
      alert(`Failed to vote: ${e.message}`);
    } finally {
      setVoting(false);
    }
  };

  const handleClose = async () => {
    if (!canClose) return;
    try {
      const updated = await api.closePoll(conversationId, pollId);
      const decrypted = await decryptPoll(updated);
      setPoll(decrypted);
    } catch (e: any) {
      alert(`Failed to close poll: ${e.message}`);
    }
  };

  return (
    <div className="p-3 sm:p-4 bg-[#17212b] border border-[#242f3d] rounded-2xl w-full max-w-[280px] sm:max-w-sm sm:w-84 shadow-xl select-none">
      {/* Poll Header: Badges */}
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {poll.is_quiz && (
          <span className="px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[10px] font-bold flex items-center gap-1">
            <HelpCircle size={10} /> Quiz
          </span>
        )}
        {poll.is_anonymous ? (
          <span className="px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-500/30 text-[10px] font-bold flex items-center gap-1">
            <Lock size={10} /> Anonymous
          </span>
        ) : (
          <span className="px-2 py-0.5 rounded-full bg-slate-700 text-slate-300 text-[10px] font-semibold">
            Public Votes
          </span>
        )}
        {poll.allows_multiple && (
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold">
            Multiple Choice
          </span>
        )}
        {poll.is_closed && (
          <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-300 text-[10px] font-bold">
            Closed
          </span>
        )}
      </div>

      {/* Question */}
      <h4 className="text-sm font-bold text-white mb-3 leading-snug">{poll.question}</h4>

      {/* Options List */}
      <div className="space-y-2 mb-3">
        {poll.options?.map((opt) => {
          const isMyVote = poll.my_votes?.includes(opt.id);
          const percent =
            poll.total_votes > 0 ? Math.round((opt.vote_count / poll.total_votes) * 100) : 0;
          const isCorrect = poll.is_quiz && poll.correct_option === opt.id;
          const isWrong = poll.is_quiz && hasVoted && isMyVote && !isCorrect;

          return (
            <button
              id={'poll-option-btn-' + opt.id}
              key={opt.id}
              type="button"
              disabled={poll.is_closed || voting}
              onClick={() => handleVote(opt.id)}
              className={`relative w-full overflow-hidden text-left p-2.5 rounded-xl border transition cursor-pointer ${
                isWrong
                  ? 'border-red-500/60 bg-red-950/20'
                  : isCorrect && (hasVoted || poll.is_closed)
                  ? 'border-emerald-500/60 bg-emerald-950/20'
                  : isMyVote
                  ? 'border-[#24A1DE] bg-[#24A1DE]/15'
                  : 'border-[#242f3d] bg-[#202b36] hover:bg-[#253240]'
              }`}
            >
              {/* Progress background bar if voted or closed */}
              {(hasVoted || poll.is_closed) && (
                <div
                  className={`absolute top-0 bottom-0 left-0 transition-all duration-500 ${
                    isCorrect
                      ? 'bg-emerald-500/25'
                      : isWrong
                      ? 'bg-red-500/25'
                      : isMyVote
                      ? 'bg-[#24A1DE]/30'
                      : 'bg-white/10'
                  }`}
                  style={{ width: `${percent}%` }}
                />
              )}

              <div className="relative flex items-center justify-between z-10">
                <div className="flex items-center gap-2 min-w-0 pr-2">
                  <div
                    className={`h-4 w-4 rounded-full border flex items-center justify-center flex-shrink-0 transition ${
                      isMyVote
                        ? 'border-[#24A1DE] bg-[#24A1DE] text-white'
                        : 'border-[#7f91a4]'
                    }`}
                  >
                    {isMyVote && <Check size={10} strokeWidth={3} />}
                  </div>
                  <span className="text-xs font-medium text-white truncate">{opt.text}</span>
                </div>

                {(hasVoted || poll.is_closed) && (
                  <span className="text-[11px] font-bold text-slate-300 ml-2">
                    {percent}%
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Quiz explanation if voted */}
      {poll.is_quiz && hasVoted && poll.explanation && (
        <div className="p-2.5 rounded-xl bg-purple-950/30 border border-purple-500/30 mb-3 flex items-start gap-2">
          <AlertCircle size={14} className="text-purple-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-purple-200">{poll.explanation}</p>
        </div>
      )}

      {/* Footer: Vote Count & Close Button */}
      <div className="flex items-center justify-between text-[11px] text-[#7f91a4] pt-1 border-t border-[#242f3d]">
        <span>
          {poll.total_votes} {poll.total_votes === 1 ? 'vote' : 'votes'}
        </span>

        {canClose && (
          <button
            type="button"
            onClick={handleClose}
            className="text-red-400 hover:text-red-300 font-semibold cursor-pointer"
          >
            Close Poll
          </button>
        )}
      </div>
    </div>
  );
};
