import { OnlineGameCard, OnlineGameContext } from './OnlineGameCard';

export function TicTacToeGameCard(props: { challengerName?: string; isOutgoing?: boolean; lang?: 'en' | 'fa'; network?: OnlineGameContext }) {
  return <OnlineGameCard kind="ttt" {...props} />;
}
