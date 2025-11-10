// createAdmin.js
const bcrypt = require('bcryptjs');

async function hashPassword() {
  // Elige tu contraseña de administrador
  const myPassword = 'admin123'; 

  // Genera el "hash" (contraseña encriptada)
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(myPassword, salt);

  console.log('--- ¡Copia el hash de abajo! ---');
  console.log(hash);
  console.log('---------------------------------');
  console.log('Ahora ejecuta este comando SQL en MySQL Workbench:');
  console.log(
    `INSERT INTO Users (name, email, password_hash, role) VALUES ('Admin Principal', 'admin@storeonline.com', '${hash}', 'Gerente');`
  );
}

hashPassword();