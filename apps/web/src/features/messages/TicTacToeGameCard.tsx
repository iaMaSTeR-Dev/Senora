import React, { useState } from 'react';
import { RotateCcw, Trophy } from 'lucide-react';

interface TicTacToeGameCardProps {
  challengerName?: string;
  isOutgoing?: boolean;
  lang?: 'en' | 'fa';
}

type Player = 'X' | 'O';
type Cell = Player | null;

export const TicTacToeGameCard: React.FC<TicTacToeGameCardProps> = ({
  challengerName = 'Player',
  isOutgoing = false,
  lang = 'fa',
}) => {
  const [board, setBoard] = useState<Cell[]>(Array(9).fill(null));
  const [turn, setTurn] = useState<Player>('X');
  const [winner, setWinner] = useState<Player | 'draw' | null>(null);
  const [winningLine, setWinningLine] = useState<number[] | null>(null);
  const [scores, setScores] = useState<{ X: number; O: number }>({ X: 0, O: 0 });

  const WIN_COMBOS = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // Rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // Columns
    [0, 4, 8], [2, 4, 6]             // Diagonals
  ];

  const checkWinner = (newBoard: Cell[]): { winner: Player | 'draw' | null; line: number[] | null } => {
    for (const combo of WIN_COMBOS) {
      const [a, b, c] = combo;
      if (newBoard[a] && newBoard[a] === newBoard[b] && newBoard[a] === newBoard[c]) {
        return { winner: newBoard[a], line: combo };
      }
    }
    if (newBoard.every((cell) => cell !== null)) {
      return { winner: 'draw', line: null };
    }
    return { winner: null, line: null };
  };

  const handleCellClick = (idx: number) => {
    if (board[idx] || winner) return;

    const newBoard = [...board];
    newBoard[idx] = turn;
    setBoard(newBoard);

    const result = checkWinner(newBoard);
    if (result.winner) {
      setWinner(result.winner);
      setWinningLine(result.line);
      if (result.winner === 'X') {
        setScores((prev) => ({ ...prev, X: prev.X + 1 }));
      } else if (result.winner === 'O') {
        setScores((prev) => ({ ...prev, O: prev.O + 1 }));
      }
    } else {
      setTurn(turn === 'X' ? 'O' : 'X');
    }
  };

  const resetGame = () => {
    setBoard(Array(9).fill(null));
    setTurn('X');
    setWinner(null);
    setWinningLine(null);
  };

  return (
    <div className={`p-4 rounded-2xl select-none w-72 ${isOutgoing ? 'bg-sky-950/40 border border-sky-500/20' : 'bg-[#182533] border border-[#242f3d]'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 border-b border-slate-700/40 pb-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-white">
          <span className="text-base">❌⭕</span>
          <span>{lang === 'fa' ? 'بازی دوز آنلاین' : 'Tic-Tac-Toe'}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
          <span className="text-rose-400 font-bold">X: {scores.X}</span>
          <span>|</span>
          <span className="text-sky-400 font-bold">O: {scores.O}</span>
        </div>
      </div>

      {/* Turn or Winner Banner */}
      <div className="mb-3 text-center text-xs font-semibold py-1 px-2 rounded-lg bg-black/20">
        {winner === 'draw' && (
          <span className="text-amber-400">{lang === 'fa' ? '🤝 بازی مساوی شد!' : "It's a Draw!"}</span>
        )}
        {winner && winner !== 'draw' && (
          <span className="text-emerald-400 flex items-center justify-center gap-1">
            <Trophy size={14} />
            {lang === 'fa' ? `🎉 بازیکن ${winner} برنده شد!` : `🎉 Player ${winner} Won!`}
          </span>
        )}
        {!winner && (
          <span className={turn === 'X' ? 'text-rose-400' : 'text-sky-400'}>
            {lang === 'fa' ? `نوبت حرکت: ${turn === 'X' ? 'ضربدر (❌)' : 'دایره (⭕)'}` : `Turn: Player ${turn}`}
          </span>
        )}
      </div>

      {/* 3x3 Grid */}
      <div className="grid grid-cols-3 gap-2 bg-[#111922] p-2.5 rounded-xl border border-slate-700/60 shadow-inner">
        {board.map((cell, idx) => {
          const isWinningCell = winningLine?.includes(idx);
          return (
            <button
              key={idx}
              type="button"
              onClick={() => handleCellClick(idx)}
              disabled={Boolean(cell || winner)}
              className={`h-16 w-full rounded-lg text-2xl font-black flex items-center justify-center transition-all cursor-pointer ${
                isWinningCell
                  ? 'bg-emerald-500/30 border-2 border-emerald-400 scale-105 shadow-md'
                  : 'bg-[#1b2734] hover:bg-[#223344] active:scale-95 border border-slate-700/40'
              } ${cell === 'X' ? 'text-rose-500' : 'text-sky-400'}`}
            >
              {cell}
            </button>
          );
        })}
      </div>

      {/* Footer controls */}
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-700/40 text-[11px]">
        <span className="text-slate-400 truncate max-w-[150px]">
          {lang === 'fa' ? 'چالش دو نفره' : `By ${challengerName}`}
        </span>
        <button
          type="button"
          onClick={resetGame}
          className="flex items-center gap-1 text-[#24A1DE] hover:text-[#52bbf0] font-semibold cursor-pointer transition"
        >
          <RotateCcw size={12} />
          <span>{lang === 'fa' ? 'دست جدید' : 'New Round'}</span>
        </button>
      </div>
    </div>
  );
};
