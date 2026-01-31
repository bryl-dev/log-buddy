function stepThree() {
  // Deliberately cause a TypeError: read property of undefined
  const obj = undefined;
  return obj.value;
}

module.exports = { stepThree };
