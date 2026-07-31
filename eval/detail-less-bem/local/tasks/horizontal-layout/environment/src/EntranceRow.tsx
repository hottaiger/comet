import { Text, View } from '@tarojs/components';
import './entrance-row.less';

export function EntranceRow() {
  return (
    <View className="entrance-row">
      <View className="entrance-row__card">
        <Text className="entrance-row__title">金融方案</Text>
      </View>
      <View className="entrance-row__card">
        <Text className="entrance-row__title">置换服务</Text>
      </View>
    </View>
  );
}
