async function testWeb() {
    console.log("Testing text query...");
    const res = await fetch("http://localhost:3001/api/ask-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "మా జిల్లా గుంటూరు, గుంటూరులో వాతావరణం ఎలా ఉంది ఈరోజు?" })
    });
    const data = await res.json();
    console.log("Result:", JSON.stringify(data, null, 2));
}

testWeb().catch(err => console.error(err));
