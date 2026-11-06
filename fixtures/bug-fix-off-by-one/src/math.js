export function calculateAverage(arr) {
  if (!arr || arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i <= arr.length; i++) {
    if (arr[i]) sum += arr[i];
  }
  return sum / arr.length;
}
