// utils/fuelTypes.js
//
// Fonte única dos tipos de combustível no backend.
//
// O sistema convive com TRÊS grafias do mesmo combustível, e cada tela
// mapeava por conta própria:
//   - chave de ordem  (refuelings.fuelType):      dieselS10, dieselS500, gasolinaComum…
//   - chave de tanque (vehicles.fuelLevels do comboio): dieselS10, dieselComum
//   - rótulo          (partners.fuel_prices / relatórios): 'Diesel S10', 'Diesel S500'…
//
// O comboio carrega só dois tanques. Diesel S500 e "Diesel Comum" são o mesmo
// produto — a ordem ao posto usa S500, o tanque do comboio chama de Comum.

const FUEL_LABELS = {
    dieselS10: 'Diesel S10',
    dieselS500: 'Diesel S500',
    dieselComum: 'Diesel Comum',
    gasolinaComum: 'Gasolina Comum',
    gasolinaAditivada: 'Gasolina Aditivada',
    etanol: 'Etanol',
    arla32: 'Arla 32',
};

// Tanques que um comboio pode ter (chaves de vehicles.fuelLevels).
const COMBOIO_TANK_KEYS = ['dieselS10', 'dieselComum'];

const semAcento = (s) => String(s || '').trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Qualquer grafia → chave de ordem. Devolve null se não reconhecer.
const toKey = (value) => {
    if (!value) return null;
    if (FUEL_LABELS[value]) return value;
    const v = semAcento(value);
    if (v.includes('ARLA')) return 'arla32';
    if (v.includes('S10') || v.includes('S-10')) return 'dieselS10';
    if (v.includes('S500') || v.includes('S-500') || v === 'DIESELCOMUM' || v.includes('DIESEL COMUM')) {
        return v.includes('COMUM') ? 'dieselComum' : 'dieselS500';
    }
    if (v.includes('ADITIVADA')) return 'gasolinaAditivada';
    if (v.includes('GASOLINA')) return 'gasolinaComum';
    if (v.includes('ETANOL')) return 'etanol';
    if (v.includes('DIESEL')) return 'dieselS10';
    return null;
};

// Qualquer grafia → chave do tanque do comboio (dieselS10 | dieselComum) ou null.
const toComboioTankKey = (value) => {
    const key = toKey(value);
    if (key === 'dieselS10') return 'dieselS10';
    if (key === 'dieselS500' || key === 'dieselComum') return 'dieselComum';
    return null;
};

// Tanque do comboio → chave usada na ordem ao posto.
const tankKeyToOrderKey = (tankKey) => (tankKey === 'dieselComum' ? 'dieselS500' : tankKey);

const fuelLabel = (value) => FUEL_LABELS[toKey(value)] || value || '';

// Chaves possíveis em partner_fuel_prices para um combustível: o cadastro de
// parceiros grava rótulo ('Diesel S10') e a baixa grava chave ('dieselS10').
const priceKeysFor = (value) => {
    const key = toKey(value);
    if (!key) return value ? [value] : [];
    const keys = new Set([key, FUEL_LABELS[key]]);
    if (key === 'dieselComum' || key === 'dieselS500') {
        keys.add('dieselS500');
        keys.add('dieselComum');
        keys.add(FUEL_LABELS.dieselS500);
        keys.add(FUEL_LABELS.dieselComum);
    }
    return [...keys];
};

module.exports = {
    FUEL_LABELS,
    COMBOIO_TANK_KEYS,
    toKey,
    toComboioTankKey,
    tankKeyToOrderKey,
    fuelLabel,
    priceKeysFor,
};
