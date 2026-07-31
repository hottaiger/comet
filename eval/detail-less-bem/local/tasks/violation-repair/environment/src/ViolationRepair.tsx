import { Text, View } from '@tarojs/components';
import './violation-repair.less';

const actions = ['预约看车', '在线咨询'];

export function ViolationRepair() {
  return (
    <View className="service-card">
      <Text className="service-card__title">专属服务</Text>
      <View className="service-card__actions">
        {actions.map((action) => (
          <Text key={action} className="service-card__action">{action}</Text>
        ))}
      </View>
    </View>
  );
}
