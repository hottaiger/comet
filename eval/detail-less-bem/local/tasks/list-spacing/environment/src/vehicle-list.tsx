import { Text, View } from '@tarojs/components';

import './vehicle-list.less';

type Vehicle = {
  id: string;
  name: string;
};

export function VehicleList({ vehicles }: { vehicles: Vehicle[] }) {
  return (
    <View className="vehicle-list">
      {vehicles.map((vehicle) => (
        <View className="vehicle-list__item" key={vehicle.id}>
          <Text className="vehicle-list__name">{vehicle.name}</Text>
        </View>
      ))}
    </View>
  );
}

