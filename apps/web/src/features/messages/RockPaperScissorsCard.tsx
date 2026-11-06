import React, { useState } from 'react';
import { RotateCcw, Swords, Trophy } from 'lucide-react';

interface RockPaperScissorsCardProps {
  challengerName?: string;
  isOutgoing?: boolean;
  lang?: 'en' | 'fa';
}

type Choice = 'rock' | 'paper' | 'scissors';

const CHOICES: { id: Choice; labelFa: string; labelEn: string; icon: string }[] = [
  { id: 'rock', labelFa: 'سنگ', labelEn: 'Rock', icon: '✊' },
  { id: 'paper', labelFa: 'کاغذ', labelEn: 'Paper', icon: '✋' },
  { id: 'scissors', labelFa: 'قیچی', labelEn: 'Scissors', icon: '✌️' },
];

export const RockPaperScissorsCard: React.FC<RockPaperScissorsCardProps> = ({
  challengerName = 'User',
  isOutgoing = false,
  lang = 'fa',
}) => {
  const [playerChoice, setPlayerChoice] = useState<Choice | null>(null);
  const [opponentChoice, setOpponentChoice] = useState<Choice | null>(null);
  const [isRevealed, setIsRevealed] = useState(false);
  const [result, setResult] = useState<'win' | 'lose' | 'draw' | null>(null);

  const determineWinner = (p1: Choice, p2: Choice): 'win' | 'lose' | 'draw' => {
    if (p1 === p2) return 'draw';
    if (
      (p1 === 'rock' && p2 === 'scissors') ||
      (p1 === 'paper' && p2 === 'rock') ||
      (p1 === 'scissors' && p2 === 'paper')
    ) {
      return 'win';
    }
    return 'lose';
  };

  const handleSelect = (choice: Choice) => {
    if (playerChoice) return;
    setPlayerChoice(choice);

    // Opponent makes choice (realistic delay)
    const options: Choice[] = ['rock', 'paper', 'scissors'];
    const opp = options[Math.floor(Math.random() * options.length)];
    setOpponentChoice(opp);

    setTimeout(() => {
      setIsRevealed(true);
      setResult(determineWinner(choice, opp));
    }, 800);
  };

  const resetGame = () => {
    setPlayerChoice(null);
    setOpponentChoice(null);
    setIsRevealed(false);
    setResult(null);
  };

  const getChoiceIcon = (c: Choice | null) => {
    if (!c) return '❓';
    if (c === 'rock') return '✊';
    if (c === 'paper') return '✋';
    return '✌️';
  };

  return (
    <div className={`p-4 rounded-2xl select-none w-72 ${isOutgoing ? 'bg-sky-950/40 border border-sky-500/20' : 'bg-[#182533] border border-[#242f3d]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-700/40 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-white">
          <span className="text-base">✂️✊</span>
          <span>{lang === 'fa' ? 'سنگ، کاغذ، قیچی' : 'Rock Paper Scissors'}</span>
        </div>
        <Swords size={16} className="text-amber-400" />
      </div>

      {/* Battle Stage */}
      <div className="bg-[#111922] p-3 rounded-xl border border-slate-700/60 mb-3 flex items-center justify-around shadow-inner">
        <div className="flex flex-col items-center">
          <span className="text-[10px] text-slate-400 mb-1">{lang === 'fa' ? 'انتخاب شما' : 'You'}</span>
          <div className={`text-4xl h-12 w-12 flex items-center justify-center rounded-xl bg-[#1b2734] border border-slate-700/50 transition-transform ${playerChoice && !isRevealed ? 'animate-bounce' : ''}`}>
            {playerChoice ? getChoiceIcon(playerChoice) : '❓'}
          </div>
        </div>

        <div className="text-xs font-black text-slate-500">VS</div>

        <div className="flex flex-col items-center">
          <span className="text-[10px] text-slate-400 mb-1">{challengerName}</span>
          <div className="text-4xl h-12 w-12 flex items-center justify-center rounded-xl bg-[#1b2734] border border-slate-700/50">
            {isRevealed ? getChoiceIcon(opponentChoice) : (playerChoice ? '🔒' : '❓')}
          </div>
        </div>
      </div>

      {/* Status Banner */}
      <div className="mb-3 text-center text-xs font-semibold py-1.5 px-2 rounded-lg bg-black/25">
        {!playerChoice && (
          <span className="text-sky-300">{lang === 'fa' ? 'حرکت خودت رو انتخاب کن:' : 'Choose your move:'}</span>
        )}
        {playerChoice && !isRevealed && (
          <span className="text-amber-300 animate-pulse">{lang === 'fa' ? 'در انتظار حرکت حریف...' : 'Waiting for opponent...'}</span>
        )}
        {isRevealed && result === 'win' && (
          <span className="text-emerald-400 flex items-center justify-center gap-1">
            <Trophy size={14} /> {lang === 'fa' ? '🎉 هورااا! برنده شدی!' : '🎉 You Won!'}
          </span>
        )}
        {isRevealed && result === 'lose' && (
          <span className="text-rose-400">{lang === 'fa' ? 'شکست خوردی! دور بعد جبران کن!' : 'You Lost! Try again!'}</span>
        )}
        {isRevealed && result === 'draw' && (
          <span className="text-amber-400">{lang === 'fa' ? '🤝 مساوی! هر دو یکسان انتخاب کردید!' : "It's a Tie!"}</span>
        )}
      </div>

      {/* Action Buttons */}
      {!playerChoice ? (
        <div className="grid grid-cols-3 gap-2">
          {CHOICES.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => handleSelect(c.id)}
              className="py-2 px-1 rounded-xl bg-[#1f2d3d] hover:bg-[#283b4f] active:scale-95 border border-slate-700/60 flex flex-col items-center gap-1 transition cursor-pointer text-white"
            >
              <span className="text-2xl">{c.icon}</span>
              <span className="text-[10px] font-bold">{lang === 'fa' ? c.labelFa : c.labelEn}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center justify-between pt-1 text-[11px]">
          <span className="text-slate-400">{isRevealed ? (lang === 'fa' ? 'بازی به پایان رسید' : 'Round Finished') : (lang === 'fa' ? 'حرکت ثبت شد' : 'Move Locked')}</span>
          <button
            type="button"
            onClick={resetGame}
            className="flex items-center gap-1 text-[#24A1DE] hover:text-[#52bbf0] font-semibold cursor-pointer transition"
          >
            <RotateCcw size={12} />
            <span>{lang === 'fa' ? 'دست جدید' : 'New Round'}</span>
          </button>
        </div>
      )}
    </div>
  );
};
