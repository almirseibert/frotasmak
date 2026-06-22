import React from 'react';
import api from '../../api/client';
import SearchableList, { ListItem } from '../../components/SearchableList';
import { num, dateTimeBR, join } from '../../utils/format';

export default function SigaSulScreen() {
  return (
    <SearchableList
      fetcher={api.getSigasulPositions}
      placeholder="Placa…"
      autoCapitalize="characters"
      emptyIcon="map-marker-off-outline"
      emptyTitle="Sem posições recebidas"
      searchText={(p) => [p.pos_placa, p.veiculo_tipo]}
      renderItem={(item) => {
        const ligado = Number(item.pos_ignicao) === 1 || item.pos_ignicao === true;
        const vel = item.pos_velocidade != null ? `${num(item.pos_velocidade)} km/h` : null;
        return (
          <ListItem
            icon={ligado ? 'map-marker-radius' : 'map-marker'}
            title={item.pos_placa || `Equip. ${item.pos_equip_id ?? item.pos_id_ref}`}
            pill={{
              label: ligado ? 'Ligado' : 'Desligado',
              bg: ligado ? '#d1fae5' : '#f4f4f5',
              text: ligado ? '#065f46' : '#3f3f46',
              dot: ligado ? '#10b981' : '#a1a1aa',
            }}
            meta={join(item.veiculo_tipo, vel, dateTimeBR(item.pos_data_hora_receb))}
          />
        );
      }}
    />
  );
}
