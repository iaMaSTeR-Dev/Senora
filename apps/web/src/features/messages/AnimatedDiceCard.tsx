import React, { useState, useEffect } from 'react';
import { RotateCcw } from 'lucide-react';
import { DiceResult, legacyDiceResult } from './dice';

interface AnimatedDiceCardProps {
  emoji: '🎲' | '🎯' | '🏀' | '⚽' | '🎰';
  senderName?: string;
  messageId?: string;
  result?: DiceResult;
  onRollAgain?: () => void;
  isOutgoing?: boolean;
  lang?: 'en' | 'fa';
}

export const AnimatedDiceCard: React.FC<AnimatedDiceCardProps> = ({
  emoji,
  senderName,
  messageId, result, onRollAgain,
  isOutgoing = false,
  lang = 'fa',
}) => {
  const [rolling, setRolling] = useState(true);
  const [outcome, setOutcome] = useState<number>(result?.outcome || 1);
  const [slotSymbols, setSlotSymbols] = useState<string[]>(['💎', '7️⃣', '🍒']);

  const SLOT_ICONS = ['🍒', '🍋', '🔔', '💎', '7️⃣'];

  useEffect(() => {
    let active = true; setRolling(true);
    const settled = result ? Promise.resolve(result) : legacyDiceResult(messageId || `${senderName}:${emoji}`);
    settled.then(value => {
      if (!active) return;
      setOutcome(value.outcome);
      setSlotSymbols(value.slots.map(index => SLOT_ICONS[index] || SLOT_ICONS[0]));
    });
    const timer = setTimeout(() => { if (active) setRolling(false); }, 1100);
    return () => { active = false; clearTimeout(timer); };
  }, [emoji, messageId, result?.outcome, result?.slots.join(',')]);

  // Dice dot layouts
  const renderDiceFace = (val: number) => {
    const dots: boolean[][] = {
      1: [[false, false, false], [false, true, false], [false, false, false]],
      2: [[true, false, false], [false, false, false], [false, false, true]],
      3: [[true, false, false], [false, true, false], [false, false, true]],
      4: [[true, false, true], [false, false, false], [true, false, true]],
      5: [[true, false, true], [false, true, false], [true, false, true]],
      6: [[true, false, true], [true, false, true], [true, false, true]],
    }[val] || [[false, true, false]];

    return (
      <div className={`w-20 h-20 rounded-2xl bg-white shadow-xl flex flex-col justify-between p-3 border-2 border-slate-200 transition-transform duration-300 ${rolling ? 'animate-spin' : 'hover:scale-105'}`}>
        {dots.map((row, rIdx) => (
          <div key={rIdx} className="flex justify-between items-center w-full">
            {row.map((active, cIdx) => (
              <div
                key={cIdx}
                className={`w-3.5 h-3.5 rounded-full ${active ? 'bg-[#1c242f] shadow-inner' : 'opacity-0'}`}
              />
            ))}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className={`flex flex-col items-center justify-center p-4 rounded-2xl select-none max-w-[260px] ${isOutgoing ? 'bg-sky-950/40 border border-sky-500/20' : 'bg-[#182533] border border-[#242f3d]'}`}>
      <div className="text-xs font-semibold text-slate-400 mb-2">
        {senderName ? `${senderName}: ` : ''}{emoji} {lang === "fa" ? 'بازی شانس تلگرامی' : 'Telegram Mini Dice'}
      </div>

      {/* Animation Stage */}
      <div className="h-28 flex items-center justify-center relative">
        {emoji === '🎲' && renderDiceFace(outcome)}

        {emoji === '🎯' && (
          <div className="flex flex-col items-center">
            <div className={`relative w-24 h-24 rounded-full border-4 border-red-600 bg-white flex items-center justify-center shadow-lg transition-transform duration-300 ${rolling ? 'scale-90 opacity-70' : 'scale-100'}`}>
              <div className="w-16 h-16 rounded-full border-4 border-red-500 bg-red-100 flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white text-[10px] font-bold">
                  {outcome === 6 ? '🎯' : outcome}
                </div>
              </div>
              {!rolling && (
                <div className="absolute -top-1 -right-1 text-2xl animate-bounce">
                  🏹
                </div>
              )}
            </div>
            <span className="text-xs font-bold text-amber-400 mt-1">
              {rolling ? (lang === "fa" ? 'در حال پرتاب...' : 'Throwing...') : (outcome >= 5 ? (lang === "fa" ? '🎯 به هدف خورد! عالی!' : 'Bullseye!') : (lang === 'fa' ? `${outcome} امتیاز` : `${outcome} points`))}
            </span>
          </div>
        )}

        {emoji === '🏀' && (
          <div className="flex flex-col items-center">
            <div className={`text-5xl transition-all duration-700 ${rolling ? '-translate-y-4 rotate-180 scale-110' : 'translate-y-0 rotate-0'}`}>
              🏀
            </div>
            <div className="text-3xl mt-1">🗑️</div>
            <span className="text-xs font-bold mt-1 text-emerald-400">
              {rolling ? (lang === "fa" ? 'شوت به سمت سبد...' : 'Shooting...') : (outcome >= 3 ? (lang === "fa" ? '🔥 گل شد! امتیاز کامل!' : 'Swish! Bucket!') : (lang === "fa" ? 'خورد به لبه سبد!' : 'Bounced off rim!'))}
            </span>
          </div>
        )}

        {emoji === '⚽' && (
          <div className="flex flex-col items-center">
            <div className={`text-5xl transition-all duration-700 ${rolling ? '-translate-y-4 scale-110 rotate-180' : 'translate-y-0'}`}>
              ⚽
            </div>
            <div className="text-3xl mt-1">🥅</div>
            <span className="text-xs font-bold mt-1 text-emerald-400">
              {rolling ? (lang === "fa" ? 'ضربه به سمت دروازه...' : 'Penalty Kick...') : (outcome >= 3 ? (lang === "fa" ? '🎉 گلللللللل!' : 'GOAAAL!') : (lang === "fa" ? '🧤 مهار شد توسط گلر!' : 'Saved by Keeper!'))}
            </span>
          </div>
        )}

        {emoji === '🎰' && (
          <div className="flex flex-col items-center bg-black/40 p-3 rounded-xl border border-amber-500/30">
            <div className="flex gap-2 text-2xl font-bold bg-[#111922] px-3 py-1.5 rounded-lg border border-slate-700">
              <span className={rolling ? 'animate-pulse' : ''}>{slotSymbols[0]}</span>
              <span className={rolling ? 'animate-pulse delay-75' : ''}>{slotSymbols[1]}</span>
              <span className={rolling ? 'animate-pulse delay-150' : ''}>{slotSymbols[2]}</span>
            </div>
            <span className="text-[11px] font-bold text-amber-300 mt-1.5">
              {rolling ? (lang === "fa" ? 'گردونه در حال چرخش...' : 'Spinning...') : (slotSymbols[0] === slotSymbols[1] && slotSymbols[1] === slotSymbols[2] ? (lang === "fa" ? '🎰🎉 جک‌پات برنده شدی!' : 'JACKPOT! 🎉') : (lang === "fa" ? 'شانس بعدیت رو امتحان کن!' : 'Try Again!'))}
            </span>
          </div>
        )}
      </div>

      {/* Outcome text & Roll Again Action */}
      <div className="flex items-center justify-between w-full mt-2 pt-2 border-t border-slate-700/50 text-xs">
        <span className="font-mono text-slate-300">
          {emoji === '🎲' && !rolling && (lang === "fa" ? `عدد تاس: ${outcome}` : `Rolled: ${outcome}`)}
          {emoji !== '🎲' && !rolling && (lang === "fa" ? 'نتیجه ثبت شد' : 'Result logged')}
          {rolling && (lang === "fa" ? 'در حال حرکت...' : 'Rolling...')}
        </span>
        <button
          type="button"
          onClick={onRollAgain}
          disabled={rolling || !onRollAgain}
          className="flex items-center gap-1 text-[11px] text-[#24A1DE] hover:text-[#52bbf0] font-semibold cursor-pointer disabled:opacity-40 transition"
        >
          <RotateCcw size={12} className={rolling ? 'animate-spin' : ''} />
          <span>{lang === "fa" ? 'دوباره' : 'Re-roll'}</span>
        </button>
      </div>
    </div>
  );
};
