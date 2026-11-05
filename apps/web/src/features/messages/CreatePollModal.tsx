import React, { useState } from 'react';
import { X, Plus, Trash2, HelpCircle } from 'lucide-react';

interface CreatePollModalProps {
  onClose: () => void;
  onSubmit: (params: {
    question: string;
    options: string[];
    is_anonymous: boolean;
    allows_multiple: boolean;
    is_quiz: boolean;
    correct_option?: number;
    explanation?: string;
  }) => void;
  submitting?: boolean;
}

export const CreatePollModal: React.FC<CreatePollModalProps> = ({
  onClose,
  onSubmit,
  submitting,
}) => {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [isAnonymous, setIsAnonymous] = useState(true);
  const [allowsMultiple, setAllowsMultiple] = useState(false);
  const [isQuiz, setIsQuiz] = useState(false);
  const [correctOption, setCorrectOption] = useState<number>(0);
  const [explanation, setExplanation] = useState('');

  const handleAddOption = () => {
    if (options.length < 10) {
      setOptions([...options, '']);
    }
  };

  const handleRemoveOption = (index: number) => {
    if (options.length > 2) {
      const next = options.filter((_, i) => i !== index);
      setOptions(next);
      if (correctOption >= next.length) {
        setCorrectOption(next.length - 1);
      }
    }
  };

  const handleOptionChange = (index: number, val: string) => {
    const next = [...options];
    next[index] = val;
    setOptions(next);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanQuestion = question.trim();
    const cleanOptions = options.map((o) => o.trim()).filter((o) => o.length > 0);

    if (!cleanQuestion) {
      alert('Poll question is required');
      return;
    }
    if (cleanOptions.length < 2) {
      alert('At least 2 non-empty options are required');
      return;
    }

    onSubmit({
      question: cleanQuestion,
      options: cleanOptions,
      is_anonymous: isAnonymous,
      allows_multiple: isQuiz ? false : allowsMultiple,
      is_quiz: isQuiz,
      correct_option: isQuiz ? correctOption : undefined,
      explanation: isQuiz && explanation.trim() ? explanation.trim() : undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-2 sm:p-4 animate-fadeIn select-none">
      <div className="w-full max-w-md bg-[#17212b] border border-[#2b5278] rounded-2xl p-4 sm:p-6 shadow-2xl animate-scaleUp max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
          <h3 className="text-base font-bold text-white">Create New Poll</h3>
          <button id="poll-close-btn" onClick={onClose} className="text-[#7f91a4] hover:text-white cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Question */}
          <div>
            <label className="block text-xs font-semibold text-[#7f91a4] uppercase tracking-wider mb-1">
              Poll Question
            </label>
            <input
              id="poll-question-input"
              type="text"
              required
              placeholder="Ask a question..."
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="w-full px-3 py-2 bg-[#242f3d] border border-[#101921] rounded-xl text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
            />
          </div>

          {/* Options */}
          <div>
            <label className="block text-xs font-semibold text-[#7f91a4] uppercase tracking-wider mb-1">
              Options (2-10)
            </label>
            <div className="space-y-2">
              {options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  {isQuiz && (
                    <input
                      id={'poll-correct-radio-' + i}
                      type="radio"
                      name="correctOption"
                      checked={correctOption === i}
                      onChange={() => setCorrectOption(i)}
                      className="text-[#24A1DE] focus:ring-0 cursor-pointer"
                      title="Mark as correct answer"
                    />
                  )}
                  <input
                    id={'poll-option-input-' + i}
                    type="text"
                    required
                    placeholder={`Option ${i + 1}`}
                    value={opt}
                    onChange={(e) => handleOptionChange(i, e.target.value)}
                    className="flex-1 px-3 py-2 bg-[#242f3d] border border-[#101921] rounded-xl text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                  />
                  {options.length > 2 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveOption(i)}
                      className="p-2 text-[#7f91a4] hover:text-red-400 transition cursor-pointer"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {options.length < 10 && (
              <button
                id="poll-add-option-btn"
                type="button"
                onClick={handleAddOption}
                className="mt-2 text-xs font-semibold text-[#24A1DE] hover:text-[#1b8bc2] flex items-center gap-1 cursor-pointer"
              >
                <Plus size={14} /> Add Option
              </button>
            )}
          </div>

          {/* Settings checkboxes */}
          <div className="space-y-2 pt-2 border-t border-[#242f3d]">
            <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
              <input
                id="poll-anon-checkbox"
                type="checkbox"
                checked={isAnonymous}
                onChange={(e) => setIsAnonymous(e.target.checked)}
                className="rounded border-[#7f91a4] text-[#24A1DE] focus:ring-0"
              />
              <span>Anonymous Voting</span>
            </label>

            {!isQuiz && (
              <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-300">
                <input
                  id="poll-multiple-checkbox"
                  type="checkbox"
                  checked={allowsMultiple}
                  onChange={(e) => setAllowsMultiple(e.target.checked)}
                  className="rounded border-[#7f91a4] text-[#24A1DE] focus:ring-0"
                />
                <span>Multiple Answers</span>
              </label>
            )}

            <label className="flex items-center gap-2 cursor-pointer text-xs text-purple-300">
              <input
                id="poll-quiz-mode-checkbox"
                type="checkbox"
                checked={isQuiz}
                onChange={(e) => setIsQuiz(e.target.checked)}
                className="rounded border-[#7f91a4] text-purple-500 focus:ring-0"
              />
              <span className="flex items-center gap-1 font-semibold">
                <HelpCircle size={12} /> Quiz Mode (Has 1 Correct Answer)
              </span>
            </label>
          </div>

          {/* Quiz Explanation */}
          {isQuiz && (
            <div className="animate-fadeIn">
              <label className="block text-xs font-semibold text-purple-300 uppercase tracking-wider mb-1">
                Quiz Explanation (Optional)
              </label>
              <textarea
                id="poll-explanation-textarea"
                rows={2}
                placeholder="Explain why the selected option is correct..."
                value={explanation}
                onChange={(e) => setExplanation(e.target.value)}
                className="w-full px-3 py-2 bg-[#242f3d] border border-purple-500/30 rounded-xl text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-purple-400"
              />
            </div>
          )}

          {/* Actions */}
          <div className="pt-2 flex justify-end gap-3 border-t border-[#242f3d]">
            <button
              id="poll-cancel-btn"
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-[#7f91a4] hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              id="poll-submit-btn"
              type="submit"
              disabled={submitting}
              className="px-5 py-2 text-xs font-semibold bg-[#24A1DE] hover:bg-[#1b8bc2] text-white rounded-xl transition disabled:opacity-50 cursor-pointer shadow-md"
            >
              {submitting ? 'Creating...' : isQuiz ? 'Create Quiz' : 'Create Poll'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
