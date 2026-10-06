// utils/tiposProdutivos.js
//
// Tipos de veículo que NÃO são equipamento produtivo (leves, apoio, prancha).
// Ficam fora de capacidade, aproveitamento e produção. Antes esta lista estava
// copiada em obraSupervisorController e planejamentoController.

const TIPOS_EXCLUIDOS_PRODUTIVOS = [
    'Leve', 'Passeio', 'Utilitario', 'Moto', 'Administrativo', 'Carro',
    'Automóvel', 'Camionete', 'Semirreboques', 'Caminhão Carroceria', 'Caminhão Prancha',
];

module.exports = { TIPOS_EXCLUIDOS_PRODUTIVOS };
