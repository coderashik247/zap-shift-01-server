const express = require('express')
const cors = require('cors')
require('dotenv').config()
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = process.env.MONGO_URL;

// middlewear
app.use(express.json());
app.use(cors());

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db('zap_shift_01_db');
    const parcelsCollection = db.collection('parcels');

    // parcels api
    app.get('/parcels', async(req, res) =>{
        const query = {};

        const {email} = req.query;

        if(email){
            query.senderEmail = email
        }

        const cursor = parcelsCollection.find(query);
        const result = await cursor.toArray();
        res.send(result);
    })

    app.post('/parcels', async(req, res) =>{
        const parcel = req.body;
        const result = await parcelsCollection.insertOne(parcel);
        res.send(result);
    })



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


app.get('/', (req, res) => {
  res.send('Zap Shift server is on')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})