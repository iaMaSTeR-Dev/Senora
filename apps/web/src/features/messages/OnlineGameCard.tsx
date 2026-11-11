import { useEffect, useMemo, useState } from 'react';
import { signalManager } from '../../crypto/signalManager';
import { Choice, GameAction, GameEvent, GameState, choiceCommitment, deriveRPS, deriveTicTacToe, rpsResult } from './gameRules';

export interface OnlineGameContext {
  gameId: string;
  challengerId: string;
  currentUserId: string;
  events: GameEvent[];
  sendAction: (action: GameAction) => Promise<void>;
}
type Secret = { choice: Choice; salt: string };
const icons = { rock: '✊', paper: '✋', scissors: '✌️' };

export function OnlineGameCard({ kind, network, lang = 'fa', challengerName = '', isOutgoing = false }: { kind: 'ttt' | 'rps'; network?: OnlineGameContext; lang?: 'en' | 'fa'; challengerName?: string; isOutgoing?: boolean }) {
  const fa = lang === 'fa';
  if (!network) return <div className="rounded-xl bg-[#182533] p-4 text-xs text-slate-300">{fa ? 'برای بازی آنلاین، دعوت بازی را در گفتگو باز کنید.' : 'Open this game invitation in a conversation to play online.'}</div>;
  return <ConnectedGame kind={kind} network={network} lang={lang} challengerName={challengerName} isOutgoing={isOutgoing} />;
}

function ConnectedGame({ kind, network, lang, challengerName, isOutgoing }: {kind: 'ttt' | 'rps'; network: OnlineGameContext; lang: 'en' | 'fa'; challengerName: string; isOutgoing: boolean}) {
  const fa = lang === 'fa'; const {gameId, challengerId, currentUserId, events} = network;
  const initial = useMemo(() => deriveTicTacToe(gameId, challengerId, []), [gameId, challengerId]);
  const [state, setState] = useState<GameState>(initial);
  const [secret, setSecret] = useState<Secret>();
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (kind === 'ttt') setState(deriveTicTacToe(gameId, challengerId, events));
    else deriveRPS(gameId, challengerId, events).then(value => {if (alive) setState(value);});
    return () => {alive = false;};
  }, [kind, gameId, challengerId, events]);
  const secretId = `rps:${gameId}:${state.round}:${currentUserId}`;
  useEffect(() => {
    let alive = true; setSecret(undefined);
    if (kind === 'rps') signalManager.getStore().getMetadata<Secret>(secretId).then(value => {if (alive) setSecret(value);}).catch(() => {});
    return () => {alive = false;};
  }, [kind, secretId]);
  const act = async (action: Omit<GameAction, 'game_id' | 'round'>, round = state.round) => {
    if (busy) return; setBusy(true); setError('');
    try {await network.sendAction({...action, game_id: gameId, round});}
    catch {setError(fa ? 'ارسال حرکت انجام نشد؛ دوباره تلاش کنید.' : 'Move could not be sent. Try again.');}
    finally {setBusy(false);}
  };
  const choose = async (choice: Choice) => {
    if (busy || state.commitments[currentUserId]) return;
    const value = secret || { choice, salt: Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('') };
    try {
      await signalManager.getStore().setMetadata(secretId, value); setSecret(value);
      await act({ action: 'commit', commitment: await choiceCommitment(gameId, state.round, currentUserId, value.choice, value.salt) });
    } catch {setError(fa ? 'ذخیرهٔ امن حرکت روی این دستگاه ممکن نیست.' : 'This device could not securely retain your move.');}
  };
  const participant = state.players.includes(currentUserId);
  const mayJoin = !state.players[1] && currentUserId !== challengerId;
  const theirId = state.players.find(id => id && id !== currentUserId) || '';
  const ours = state.reveals[currentUserId]; const theirs = state.reveals[theirId];
  const finished = kind === 'ttt' ? Boolean(state.winner) : Boolean(state.players[1] && state.players.every(id => state.reveals[id]));
  const result = ours && theirs ? rpsResult(ours, theirs) : undefined;
  return <div className={`w-72 rounded-2xl border p-4 ${isOutgoing ? 'border-sky-500/20 bg-sky-950/40' : 'border-[#242f3d] bg-[#182533]'}`} data-game-id={gameId} data-round={state.round}>
    <p className="mb-3 text-sm font-bold text-white">{kind === 'ttt' ? (fa ? 'دوز دو نفره' : 'Tic-Tac-Toe') : (fa ? 'سنگ، کاغذ، قیچی' : 'Rock Paper Scissors')}</p>
    <p className="mb-2 text-xs text-slate-400">{challengerName}{!state.players[1] && (fa ? ' — در انتظار حریف' : ' — waiting for an opponent')}</p>
    {mayJoin && <button type="button" disabled={busy} onClick={() => act({ action: 'join' })} className="mb-3 rounded bg-sky-700 px-3 py-2 text-white">{fa ? 'پیوستن به بازی' : 'Join game'}</button>}
    {kind === 'ttt' ? <>
      <p className="mb-2 text-xs text-slate-300">{state.winner ? (state.winner === 'draw' ? (fa ? 'بازی مساوی شد' : 'Draw') : `${fa ? 'برنده' : 'Winner'}: ${state.winner}`) : `${fa ? 'نوبت' : 'Turn'}: ${state.moves % 2 === 0 ? 'X' : 'O'}`}</p>
      <div className="grid grid-cols-3 gap-2" aria-label="Tic-Tac-Toe board">{state.board.map((cell,index) => <button key={index} type="button" aria-label={`Cell ${index + 1}`} disabled={busy || Boolean(cell || state.winner) || currentUserId !== state.players[state.moves % 2]} onClick={() => act({ action: 'move', cell: index, seq: state.moves })} className={`h-16 rounded border text-2xl font-bold text-white ${state.winningLine?.includes(index) ? 'border-emerald-400 bg-emerald-800' : 'border-slate-600 bg-[#1b2734]'}`}>{cell}</button>)}</div>
    </> : <>
      <p className="mb-3 text-center text-3xl">{ours || secret ? icons[ours || secret!.choice] : '❓'} <span className="text-sm">VS</span> {finished && theirs ? icons[theirs] : '🔒'}</p>
      {participant && !state.commitments[currentUserId] && <div className="grid grid-cols-3 gap-2">{(['rock','paper','scissors'] as const).map(choice => <button type="button" disabled={busy} key={choice} aria-label={choice} onClick={() => choose(choice)} className="rounded bg-slate-700 py-3 text-xl">{icons[choice]}</button>)}</div>}
      {participant && state.commitments[currentUserId] && !ours && <p className="my-2 text-xs text-amber-300">{fa ? 'حرکت شما قفل شده است؛ پس از انتخاب هر دو نفر، آن را آشکار کنید.' : 'Your move is locked. Reveal it after both players have chosen.'}</p>}
      {participant && state.players[1] && state.players.every(id => state.commitments[id]) && !ours && <button type="button" disabled={busy || !secret} onClick={() => secret && act({ action: 'reveal', choice: secret.choice, salt: secret.salt })} className="mt-2 rounded bg-indigo-700 px-3 py-2 text-white">{secret ? (fa ? 'آشکار کردن حرکت' : 'Reveal move') : (fa ? 'حرکت را روی دستگاه اصلی آشکار کنید' : 'Reveal on the original device')}</button>}
      {result && <p role="status" className="mt-3 text-sm text-emerald-300">{result === 'draw' ? (fa ? 'بازی مساوی شد' : 'Draw') : result === 'win' ? (fa ? 'برنده شدید' : 'You won') : (fa ? 'حریف برنده شد' : 'Opponent won')}</p>}
    </>}
    {participant && finished && <button type="button" disabled={busy} onClick={() => act({ action: 'restart' },state.round + 1)} className="mt-3 text-xs text-sky-300">{fa ? 'دست جدید' : 'New round'}</button>}
    {!participant && !mayJoin && <p className="mt-2 text-xs text-slate-400">{fa ? 'شما تماشاگر این بازی هستید.' : 'You are spectating this game.'}</p>}
    {busy && <p className="mt-2 text-xs text-slate-400">{fa ? 'در حال ارسال حرکت…' : 'Sending move…'}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-rose-300">{error}</p>}
  </div>;
}
