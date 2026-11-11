import { OnlineGameCard, OnlineGameContext } from './OnlineGameCard';

export function RockPaperScissorsCard(props: { challengerName?: string; isOutgoing?: boolean; lang?: 'en' | 'fa'; network?: OnlineGameContext }) {
  return <OnlineGameCard kind="rps" {...props} />;
}
