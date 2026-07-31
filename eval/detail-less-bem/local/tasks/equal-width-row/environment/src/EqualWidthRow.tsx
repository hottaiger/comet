import { Text, View } from '@tarojs/components';
import './equal-width-row.less';

type EqualWidthRowProps = {
  hasTradeIn: boolean;
};

export function EqualWidthRow({ hasTradeIn }: EqualWidthRowProps) {
  const entries = hasTradeIn ? ['金融方案', '置换估价'] : ['金融方案'];
  return (
    <View className="entry-row">
      {entries.map((entry) => (
        <View key={entry} className="entry-card">
          <Text className="entry-card__title">{entry}</Text>
        </View>
      ))}
    </View>
  );
}
