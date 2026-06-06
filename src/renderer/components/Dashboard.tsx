import { SignalPanel } from './SignalPanel';
import { TradePanel } from './TradePanel';
import type { BotState } from '../../types';

export function Dashboard({ state }: { state: BotState | null }): JSX.Element {
  return (
    <div className="grid-2">
      <SignalPanel signal={state?.signal ?? null} />
      <TradePanel trade={state?.openTrade ?? null} />
    </div>
  );
}
