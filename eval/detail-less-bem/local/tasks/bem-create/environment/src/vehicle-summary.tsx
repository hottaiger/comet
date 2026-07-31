import { Text, View } from '@tarojs/components';

import './vehicle-summary.less';

type VehicleSummaryProps = {
  disabled: boolean;
  price: string;
  title: string;
};

export function VehicleSummary({ disabled, price, title }: VehicleSummaryProps) {
  return (
    <View className={disabled ? 'summary disabled' : 'summary'}>
      <Text className="summary-title">{title}</Text>
      <Text className="summary-price">{price}</Text>
    </View>
  );
}
