export type GameAction = {
  game_id: string;
  round: number;
  action: 'join' | 'move' | 'restart' | 'commit' | 'reveal';
  seq?: number;
  cell?: number;
  commitment?: string;
  choice?: 'rock' | 'paper' | 'scissors';
  salt?: string;
};
export type GameEvent = { id: string; actorId: string; createdAt: string; data: GameAction };
export type Choice = 'rock' | 'paper' | 'scissors';
export interface GameState {
  round: number;
  players: [string, string];
  board: Array<'X' | 'O' | null>;
  moves: number;
  winner: 'X' | 'O' | 'draw' | null;
  winningLine: number[] | null;
  commitments: Record<string, string>;
  reveals: Record<string, Choice>;
}

const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const empty = (challenger: string): GameState => ({ round: 0, players: [challenger, ''], board: Array(9).fill(null), moves: 0, winner: null, winningLine: null, commitments: {}, reveals: {} });
const ordered = (events: GameEvent[]) => [...events].sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

export function deriveTicTacToe(gameId: string, challenger: string, events: GameEvent[]): GameState {
  let state = empty(challenger);
  for (const event of ordered(events)) {
    const data = event.data;
    if (data.game_id !== gameId || !Number.isInteger(data.round)) continue;
    if (data.action === 'restart' && data.round === state.round + 1 && state.players.includes(event.actorId) && state.winner) {
      state = { ...empty(challenger), round: data.round, players: state.players }; continue;
    }
    if (data.round !== state.round) continue;
    if (data.action === 'join' && !state.players[1] && event.actorId !== challenger) { state.players[1] = event.actorId; continue; }
    if (data.action !== 'move' || state.winner || data.seq !== state.moves || event.actorId !== state.players[state.moves % 2]) continue;
    if (!Number.isInteger(data.cell) || data.cell! < 0 || data.cell! > 8 || state.board[data.cell!] !== null) continue;
    state.board[data.cell!] = state.moves % 2 === 0 ? 'X' : 'O'; state.moves++;
    for (const line of lines) if (state.board[line[0]] && line.every(cell => state.board[cell] === state.board[line[0]])) {
      state.winner = state.board[line[0]]; state.winningLine = line; break;
    }
    if (!state.winner && state.moves === 9) state.winner = 'draw';
  }
  return state;
}

export async function choiceCommitment(gameId: string, round: number, actor: string, choice: Choice, salt: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(['senora.game.rps.v1', gameId, round, actor, choice, salt])));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
}

export async function deriveRPS(gameId: string, challenger: string, events: GameEvent[]): Promise<GameState> {
  let state = empty(challenger);
  for (const event of ordered(events)) {
    const data = event.data;
    if (data.game_id !== gameId || !Number.isInteger(data.round)) continue;
    if (data.action === 'restart' && data.round === state.round + 1 && state.players.includes(event.actorId) && state.players.every(player => state.reveals[player])) {
      state = { ...empty(challenger), round: data.round, players: state.players }; continue;
    }
    if (data.round !== state.round) continue;
    if (data.action === 'join' && !state.players[1] && event.actorId !== challenger) {state.players[1] = event.actorId;continue;}
    if (!state.players.includes(event.actorId)) continue;
    if (data.action === 'commit' && !state.commitments[event.actorId] && /^[a-f0-9]{64}$/.test(data.commitment || '')) state.commitments[event.actorId] = data.commitment!;
    if (data.action === 'reveal' && state.players.every(player => state.commitments[player]) && !state.reveals[event.actorId]) {
      if (!['rock','paper','scissors'].includes(data.choice || '') || !/^[a-f0-9]{64}$/.test(data.salt || '')) continue;
      if (await choiceCommitment(gameId, state.round, event.actorId, data.choice!, data.salt!) === state.commitments[event.actorId]) state.reveals[event.actorId] = data.choice!;
    }
  }
  return state;
}

export function rpsResult(ours: Choice, theirs: Choice): 'win' | 'lose' | 'draw' {
  if (ours === theirs) return 'draw';
  return ({ rock: 'scissors', paper: 'rock', scissors: 'paper' } as const)[ours] === theirs ? 'win' : 'lose';
}
