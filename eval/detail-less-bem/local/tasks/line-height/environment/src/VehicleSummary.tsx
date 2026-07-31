import { Text, View } from '@tarojs/components';
import './vehicle-summary.less';

export function VehicleSummary() {
  return (
    <View className="vehicle-summary">
      <Text className="vehicle-summary__title">2024 款示例车辆</Text>
      <Text className="vehicle-summary__description">车况透明，支持在线咨询</Text>
    </View>
  );
}
