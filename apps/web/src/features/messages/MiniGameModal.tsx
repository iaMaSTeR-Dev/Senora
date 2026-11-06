import React, { useState, useEffect, useCallback } from 'react';
import { X, Trophy, RotateCcw, Send, Gamepad2 } from 'lucide-react';

interface MiniGameModalProps {
  onClose: () => void;
  onShareScore: (gameName: string, score: number) => void;
  lang?: 'en' | 'fa';
}

export const MiniGameModal: React.FC<MiniGameModalProps> = ({
  onClose,
  onShareScore,
  lang = 'fa',
}) => {
  // 2048 State
  const [grid, setGrid] = useState<number[][]>(() => init2048());
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('senora_2048_best') || 0);
    } catch {
      return 0;
    }
  });
  const [gameOver, setGameOver] = useState(false);

  function init2048(): number[][] {
    const empty = Array(4).fill(0).map(() => Array(4).fill(0));
    spawnRandom(empty);
    spawnRandom(empty);
    return empty;
  }

  function spawnRandom(board: number[][]) {
    const emptyCells: { r: number; c: number }[] = [];
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        if (board[r][c] === 0) emptyCells.push({ r, c });
      }
    }
    if (emptyCells.length === 0) return;
    const randomCell = emptyCells[Math.floor(Math.random() * emptyCells.length)];
    board[randomCell.r][randomCell.c] = Math.random() < 0.9 ? 2 : 4;
  }

  const moveLeft = useCallback((board: number[][]): { newBoard: number[][]; moved: boolean; gained: number } => {
    let moved = false;
    let gained = 0;
    const newBoard = board.map((row) => {
      const filtered = row.filter((v) => v !== 0);
      const merged: number[] = [];
      for (let i = 0; i < filtered.length; i++) {
        if (filtered[i] === filtered[i + 1]) {
          const val = filtered[i] * 2;
          merged.push(val);
          gained += val;
          i++;
        } else {
          merged.push(filtered[i]);
        }
      }
      while (merged.length < 4) merged.push(0);
      if (merged.some((v, idx) => v !== row[idx])) moved = true;
      return merged;
    });
    return { newBoard, moved, gained };
  }, []);

  const rotateClockwise = (matrix: number[][]): number[][] => {
    return matrix[0].map((_, index) => matrix.map((row) => row[index]).reverse());
  };

  const handleMove = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    if (gameOver) return;

    let current = grid;
    let rotations = 0;

    if (direction === 'up') rotations = 3;
    if (direction === 'right') rotations = 2;
    if (direction === 'down') rotations = 1;

    for (let i = 0; i < rotations; i++) current = rotateClockwise(current);

    const { newBoard, moved, gained } = moveLeft(current);

    let finalBoard = newBoard;
    const backRotations = (4 - rotations) % 4;
    for (let i = 0; i < backRotations; i++) finalBoard = rotateClockwise(finalBoard);

    if (moved) {
      spawnRandom(finalBoard);
      setGrid(finalBoard);
      const nextScore = score + gained;
      setScore(nextScore);
      if (nextScore > bestScore) {
        setBestScore(nextScore);
        try {
          localStorage.setItem('senora_2048_best', String(nextScore));
        } catch {}
      }

      // Check game over
      let canMove = false;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          if (finalBoard[r][c] === 0) canMove = true;
          if (r < 3 && finalBoard[r][c] === finalBoard[r + 1][c]) canMove = true;
          if (c < 3 && finalBoard[r][c] === finalBoard[r][c + 1]) canMove = true;
        }
      }
      if (!canMove) setGameOver(true);
    }
  }, [grid, gameOver, score, bestScore, moveLeft]);

  // Keyboard navigation
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); handleMove('left'); }
      if (e.key === 'ArrowRight') { e.preventDefault(); handleMove('right'); }
      if (e.key === 'ArrowUp') { e.preventDefault(); handleMove('up'); }
      if (e.key === 'ArrowDown') { e.preventDefault(); handleMove('down'); }
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleMove, onClose]);

  const restart = () => {
    setGrid(init2048());
    setScore(0);
    setGameOver(false);
  };

  const getTileColor = (val: number): string => {
    switch (val) {
      case 2: return 'bg-slate-200 text-slate-800 font-bold';
      case 4: return 'bg-amber-100 text-slate-800 font-bold';
      case 8: return 'bg-orange-400 text-white font-bold';
      case 16: return 'bg-orange-500 text-white font-bold';
      case 32: return 'bg-rose-500 text-white font-bold';
      case 64: return 'bg-red-600 text-white font-bold';
      case 128: return 'bg-yellow-400 text-white font-bold text-xl shadow-lg';
      case 256: return 'bg-yellow-500 text-white font-bold text-xl shadow-lg';
      case 512: return 'bg-yellow-600 text-white font-bold text-xl shadow-lg';
      case 1024: return 'bg-amber-500 text-white font-bold text-lg shadow-xl';
      case 2048: return 'bg-emerald-500 text-white font-black text-lg shadow-2xl animate-pulse';
      default: return 'bg-[#1b2734] text-transparent';
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 select-none">
      <div className="w-full max-w-sm rounded-3xl bg-[#17212b] border border-[#242f3d] p-5 shadow-2xl flex flex-col relative animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between mb-4 border-b border-[#242f3d] pb-3">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-[#24A1DE] to-indigo-500 flex items-center justify-center text-white shadow-md">
              <Gamepad2 size={20} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">2048 Mini App</h3>
              <p className="text-[10px] text-[#7f91a4]">{lang === 'fa' ? 'مینی‌گیم تلگرامی' : 'Telegram WebApp Game'}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-white hover:bg-white/10 transition cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scores Bar */}
        <div className="flex items-center justify-between mb-4 gap-2">
          <div className="flex-1 bg-[#101921] py-2 px-3 rounded-xl border border-slate-700/40 text-center">
            <span className="text-[10px] text-slate-400 block uppercase font-bold">{lang === 'fa' ? 'امتیاز' : 'Score'}</span>
            <span className="text-base font-black text-white">{score}</span>
          </div>
          <div className="flex-1 bg-[#101921] py-2 px-3 rounded-xl border border-slate-700/40 text-center">
            <span className="text-[10px] text-amber-400 block uppercase font-bold flex items-center justify-center gap-1">
              <Trophy size={11} /> {lang === 'fa' ? 'بهترین' : 'Best'}
            </span>
            <span className="text-base font-black text-amber-300">{bestScore}</span>
          </div>
          <button
            type="button"
            onClick={restart}
            className="h-12 w-12 rounded-xl bg-[#242f3d] hover:bg-[#202b36] flex items-center justify-center text-[#24A1DE] transition cursor-pointer flex-shrink-0"
            title="Restart"
          >
            <RotateCcw size={18} />
          </button>
        </div>

        {/* 4x4 Grid */}
        <div className="relative bg-[#101921] p-2.5 rounded-2xl border border-slate-700/60 shadow-inner grid grid-cols-4 gap-2 aspect-square mb-4">
          {grid.map((row, r) =>
            row.map((cell, c) => (
              <div
                key={`${r}-${c}`}
                className={`h-full w-full rounded-xl flex items-center justify-center text-xl font-bold transition-all duration-100 ${getTileColor(cell)}`}
              >
                {cell > 0 ? cell : ''}
              </div>
            ))
          )}

          {gameOver && (
            <div className="absolute inset-0 bg-black/85 backdrop-blur-xs rounded-2xl flex flex-col items-center justify-center gap-3 animate-in fade-in">
              <span className="text-base font-black text-rose-400">{lang === 'fa' ? 'باختید! بازی تمام شد' : 'Game Over!'}</span>
              <p className="text-xs text-slate-300">{lang === 'fa' ? `امتیاز نهایی: ${score}` : `Final Score: ${score}`}</p>
              <div className="flex items-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={restart}
                  className="px-4 py-2 rounded-xl bg-[#24A1DE] text-white text-xs font-bold shadow-md hover:bg-[#1f93cb] cursor-pointer"
                >
                  {lang === 'fa' ? 'تلاش دوباره' : 'Try Again'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onShareScore('2048', score);
                    onClose();
                  }}
                  className="px-4 py-2 rounded-xl bg-amber-500 text-white text-xs font-bold shadow-md hover:bg-amber-600 flex items-center gap-1.5 cursor-pointer"
                >
                  <Send size={13} />
                  <span>{lang === 'fa' ? 'اشتراک رکورد' : 'Share'}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Directional Pad for mobile & easy desktop clicks */}
        <div className="flex flex-col items-center gap-1.5 mb-3">
          <button
            type="button"
            onClick={() => handleMove('up')}
            className="w-20 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-bold cursor-pointer transition active:scale-95"
          >
            ⬆️
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleMove('left')}
              className="w-16 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-bold cursor-pointer transition active:scale-95"
            >
              ⬅️
            </button>
            <button
              type="button"
              onClick={() => handleMove('down')}
              className="w-16 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-bold cursor-pointer transition active:scale-95"
            >
              ⬇️
            </button>
            <button
              type="button"
              onClick={() => handleMove('right')}
              className="w-16 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-bold cursor-pointer transition active:scale-95"
            >
              ➡️
            </button>
          </div>
        </div>

        {/* Share Score Button */}
        <button
          type="button"
          onClick={() => {
            onShareScore('2048', score);
            onClose();
          }}
          className="w-full py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#1f93cb] text-white text-xs font-bold shadow-md transition flex items-center justify-center gap-2 cursor-pointer"
        >
          <Send size={14} />
          <span>{lang === 'fa' ? `اشتراک امتیاز (${score}) در گفتگو` : `Share Score (${score}) in Chat`}</span>
        </button>
      </div>
    </div>
  );
};
