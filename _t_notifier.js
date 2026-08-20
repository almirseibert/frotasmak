const { buildOrderText, buildOrderHtml } = require('./services/orderNotifier');
const order = { authNumber: 123, date: new Date(), vehicleLabel: 'V01 - ABC1234', fuelType: 'dieselS10', liters: 50, isFillUp: false, obraName: 'Obra X', employeeName: 'Joao', partnerName: 'Posto Y', isAlteracao: true };
console.log('--- TEXT (alterada) ---');
console.log(buildOrderText(order));
console.log('--- HTML tem banner? ---', buildOrderHtml(order).includes('ORDEM ALTERADA'));
console.log('--- TEXT normal sem flag tem alerta? ---', buildOrderText({...order, isAlteracao:false}).includes('ORDEM ALTERADA'));
