const { scrapeAvailability } = require("../server");

function countSlots(data, key) {
  return Object.values(data?.[key] || {}).reduce((sum, slots) => sum + slots.length, 0);
}

scrapeAvailability()
  .then((data) => {
    const tbc = countSlots(data, "tbc");
    const ubc = countSlots(data, "ubc");
    console.log(`Updated availability: Tennis Hub ${tbc}, UBC ${ubc}, updatedAt ${data.updatedAt}`);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
